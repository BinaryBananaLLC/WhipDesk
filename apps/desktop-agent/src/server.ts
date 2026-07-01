import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { DEFAULTS, type MonitorAddMessage, type MonitorInfo, type ScheduledAction, type ScreenInfo, type ServerMessage, type TimerAddMessage, type TimerInfo, type WatchRegion } from "@whipdesk/protocol";
import { AGENT_VERSION, loadConfig, type AgentConfig } from "./config";
import { ScreenCapturer, isFullViewport, type Viewport } from "./capture/screen";
import { listDisplayGeometry, type DisplayGeometry } from "./capture/displays";
import { selectInputBackend, type InputBackend } from "./input";
import { NotificationHub } from "./notifications";
import { RegionWatcher } from "./watchers/region";
import { Presence } from "./presence";
import { KeepAwake } from "./power/keep-awake";
import { DisplayWake } from "./power/wake-display";
import { ensurePin } from "./security/setup";
import { PinThrottle } from "./security/throttle";
import type { PinGuard } from "./security/pin";
import { attachWebSocket } from "./transport/websocket";
import { startFileWatcher } from "./watchers/file-pattern";
import { videoEncodingAvailable, VideoHub } from "./capture/encoder";
import { SessionMonitor } from "./monitor/monitor";
import { log } from "./logger";

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop-agent/src -> apps/mobile-web/dist
const webDist = join(here, "..", "..", "mobile-web", "dist");

/** A connected controller. Both transports (WebSocket + WebRTC) implement this. */
export interface Controller {
  id: string;
  /** Whether the controller's UI is currently visible (Page Visibility). */
  visible: boolean;
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

/** Shared state + actions handed to transports and routes. The seam that hides plumbing. */
export interface AgentContext {
  config: AgentConfig;
  capturer: ScreenCapturer;
  input: InputBackend;
  hub: NotificationHub;
  pin: PinGuard;
  pinThrottle: PinThrottle;
  regionWatcher: RegionWatcher;
  screen: ScreenInfo;
  displays: DisplayGeometry[];
  activeDisplay: number;
  /** Whether a real WebRTC video track can be offered (ffmpeg present + opt-in). */
  videoAvailable: boolean;
  /** Shared H.264 encoder + fan-out for WebRTC video tracks (null when video is off). */
  video: VideoHub | null;
  controllers: Set<Controller>;
  addController(controller: Controller): void;
  removeController(controller: Controller): void;
  setVisibility(controller: Controller, visible: boolean): void;
  setFps(fps: number): void;
  selectDisplay(id: number): void;
  requestFrame(): void;
  /** Active crop region the host streams (normalized [0,1]). */
  getViewport(): Viewport;
  /** Crop subsequent capture to this sub-region and tell every controller about it. */
  setViewport(vp: Viewport): void;
  addWatchRegion(region: WatchRegion): void;
  removeWatchRegion(id: string): void;
  /** Schedule a one-shot reminder + optional auto-action. */
  addTimer(msg: TimerAddMessage): void;
  removeTimer(id: string): void;
  listTimers(): TimerInfo[];
  /** (Re)scan for running AI-agent sessions and push the list to controllers. */
  scanMonitors(): Promise<void>;
  /** Start monitoring a discovered session for the chosen state changes. */
  addMonitor(msg: MonitorAddMessage): void;
  removeMonitor(id: string): void;
  listMonitors(): MonitorInfo[];
}

export async function startAgent(): Promise<{ server: Server; config: AgentConfig; presence: Presence; keepAwake: KeepAwake; ctx: AgentContext }> {
  const config = loadConfig();
  const capturer = new ScreenCapturer({ quality: config.quality, maxWidth: config.maxWidth });
  await capturer.init();
  const input = await selectInputBackend();
  const hub = new NotificationHub();
  const regionWatcher = new RegionWatcher(hub);
  const presence = new Presence();
  const keepAwake = new KeepAwake();
  // Wakes (and holds on) the host display while a controller is connected, so a remote user who
  // connects to a slept/locked machine sees the password prompt instead of a black screen.
  const displayWake = new DisplayWake();
  const pin = await ensurePin(config.stateDir);
  const pinThrottle = new PinThrottle(config.stateDir);
  const videoAvailable = await videoEncodingAvailable();

  const screen: ScreenInfo = await input.getScreenSize().catch(() => ({ width: 0, height: 0 }));
  if (screen.width === 0) {
    log.warn("logical screen size unknown — pointer mapping disabled (view-only input)");
  }

  // Enumerate displays once at startup; pick the primary as active.
  const displays = await listDisplayGeometry(screen);
  let activeDisplay = displays.find((d) => d.primary)?.id ?? displays[0]?.id ?? 0;
  const applyActiveDisplay = (id: number) => {
    const target = displays.find((d) => d.id === id);
    if (!target) return false;
    activeDisplay = id;
    capturer.setDisplay(id);
    input.setActiveDisplay(
      target.width > 0 && target.height > 0
        ? { originX: target.originX, originY: target.originY, width: target.width, height: target.height }
        : null,
    );
    if (target.width > 0) {
      screen.width = target.width;
      screen.height = target.height;
    }
    return true;
  };
  applyActiveDisplay(activeDisplay);
  if (displays.length > 1) {
    log.info(
      `displays: ${displays.map((d) => `[${d.id}] ${d.name}${d.primary ? "*" : ""} ${d.width}x${d.height}`).join(", ")}`,
    );
  }

  const controllers = new Set<Controller>();
  let fps = config.fps;

  // Zero-config AI-agent session monitor: detects running agents (Claude Code, Codex, Gemini,
  // Aider, …) by observing processes + their transcripts, infers state, and fires the events a user
  // subscribed to (it polls only while a monitor is active).
  const monitor = new SessionMonitor({
    notify: (n) => hub.emit(n),
    onMonitors: (monitors) => {
      for (const c of controllers) c.send({ type: "monitors", monitors });
    },
  });

  // When the last set-viewport re-crop was requested, so we can log how long the host took to make
  // that region LIVE (the variable we replaced the controller's blind 500ms region-bridge timer with).
  let cropRequestedAt = 0;
  const video = videoAvailable
    ? new VideoHub({
        displayIndex: () => activeDisplay,
        fps: DEFAULTS.VIDEO_FPS,
        kbps: DEFAULTS.VIDEO_KBPS,
        maxWidth: config.maxWidth,
        overview: { width: DEFAULTS.OVERVIEW_WIDTH, fps: DEFAULTS.OVERVIEW_FPS, kbps: DEFAULTS.OVERVIEW_KBPS },
        // The re-cropped capture's first frame is now on the wire — tell controllers the region is
        // LIVE so they switch the displayed frame onto it exactly then, not on a fixed-time guess.
        onCropActive: (crop) => {
          const r = crop ?? { x: 0, y: 0, w: 1, h: 1 };
          if (cropRequestedAt) {
            log.debug(`video: crop ${crop ? "region" : "full"} live after ${Date.now() - cropRequestedAt}ms`);
            cropRequestedAt = 0;
          }
          const msg: ServerMessage = { type: "screen-region", x: r.x, y: r.y, w: r.w, h: r.h, active: true };
          for (const controller of controllers) controller.send(msg);
        },
        onError: () => {
          logScreenPermissionHelp();
          hub.emit({
            title: "Screen capture blocked",
            body: "Grant Screen Recording to your terminal/VS Code, then fully quit and reopen it.",
            level: "error",
            source: "capture",
          });
        },
      })
    : null;
  let looping = false;
  let captureFailing = false;
  // Active crop region the H.264 MAIN encoder is zoomed into (normalized; full = whole desktop).
  // Most-recent set-viewport wins (global, like set-quality).
  let viewport: Viewport = { x: 0, y: 0, w: 1, h: 1 };

  // One-shot timers: reminders + an optional scheduled action (auto-click/keypress when an AI
  // tool's cooldown ends). In-memory; lost on restart. On fire the action runs, then a
  // notification goes out (to connected controllers AND the cloud push relay, so the user is
  // pinged even with the app closed).
  const timers = new Map<string, { id: string; label: string; fireAtMs: number; action?: ScheduledAction }>();
  const listTimers = (): TimerInfo[] =>
    [...timers.values()].map((t) => ({ id: t.id, label: t.label, fireAtMs: t.fireAtMs, hasAction: !!t.action }));
  const broadcastTimers = () => {
    const msg: ServerMessage = { type: "timers", timers: listTimers() };
    for (const c of controllers) c.send(msg);
  };

  // A SINGLE wall-clock ticker drives every timer — NOT one long setTimeout per timer. A long
  // setTimeout is fragile: it can drift or stall across system sleep/wake and silently misses very
  // long delays, which is exactly how a 2h auto-action can "not fire". Polling Date.now() once a
  // second is robust to all of that (a due timer fires within ~1s of its wall-clock deadline, even
  // right after the machine wakes) and the un-unref'd interval keeps the event loop alive so the
  // action ALWAYS runs while `npm run agent` is up. The ticker self-stops when no timers remain.
  let timerTicker: ReturnType<typeof setInterval> | null = null;
  const ensureTimerTicker = () => {
    if (timerTicker) return;
    timerTicker = setInterval(() => {
      const now = Date.now();
      for (const t of [...timers.values()]) if (t.fireAtMs <= now) void fireTimer(t.id);
      if (timers.size === 0 && timerTicker) {
        clearInterval(timerTicker);
        timerTicker = null;
      }
    }, 1000);
  };

  const fireTimer = async (id: string) => {
    const t = timers.get(id);
    if (!t) return;
    timers.delete(id); // delete BEFORE any await so the ticker can never double-fire this timer
    broadcastTimers();
    const a = t.action;
    if (a) {
      try {
        log.info(`timer "${t.label || id}" firing${a.kind ? ` (${a.kind})` : ""}`);
        // Clicking the target IS the action for "click", and focuses it before a key/text action.
        // Give the focused app a short beat to actually take focus before we type/press — otherwise
        // the first keystrokes (e.g. an Enter that submits a prompt) can land before the field is
        // ready and get dropped. This is the robustness gap that made auto-prompt timers flaky.
        if (typeof a.x === "number" && typeof a.y === "number") {
          await input.click(a.button ?? "left", false, a.x, a.y);
          if (a.kind === "key" || a.kind === "text") await delay(250);
        }
        if (a.kind === "key" && a.key) await input.keyTap(a.key);
        else if (a.kind === "text" && a.text) await input.typeText(a.text, true);
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        log.warn("timer action failed:", message);
        hub.emit({
          title: t.label || "WhipDesk timer",
          body: `Timer reached zero, but its scheduled action failed: ${message.slice(0, 120)}`,
          level: "error",
          source: "timer",
        });
        return;
      }
    }
    hub.emit({
      title: t.label || "WhipDesk timer",
      body: a ? "Timer reached zero — scheduled action sent." : "Timer reached zero.",
      level: "success",
      source: "timer",
    });
  };

  const captureOnce = async (): Promise<"ok" | "fail" | "idle"> => {
    // The LIVE screen is the direct H.264 capture (encoder.ts); this sampler exists ONLY to feed
    // the region change-watchers, so it runs at a low rate and only while watchers are armed.
    if (regionWatcher.count === 0) return "idle";
    try {
      const frame = await capturer.capture();
      if (captureFailing) {
        captureFailing = false;
        log.info("screen capture recovered");
      }
      regionWatcher.check(frame);
      return "ok";
    } catch (error) {
      const message = (error as Error).message ?? "";
      const permission =
        /could not create image|denied|not authorized|operation not permitted|unable to/i.test(message);
      if (!captureFailing) {
        captureFailing = true;
        log.error("screen capture failed:", message.split("\n")[0]);
        if (permission) logScreenPermissionHelp();
        hub.emit({
          title: "Screen capture blocked",
          body: permission
            ? "Grant Screen Recording to your terminal/VS Code, then restart it."
            : message.slice(0, 160),
          level: "error",
          source: "capture",
        });
      }
      return "fail";
    }
  };

  const runLoop = async () => {
    if (looping) return;
    looping = true;
    // Runs ONLY while region watchers are armed: they need periodic full-desktop samples to diff
    // (so you still get change alerts with the phone away). The live screen the controller sees is
    // the direct H.264 capture and never touches this loop.
    while (regionWatcher.count > 0) {
      const started = Date.now();
      const result = await captureOnce();
      const budget = result === "fail" ? 1500 : 1200;
      const elapsed = Date.now() - started;
      if (elapsed < budget) await delay(budget - elapsed);
    }
    looping = false;
  };
  const ensureLoop = () => {
    if (!looping) void runLoop();
  };

  const updatePresence = () => presence.update(controllers.size);

  const ctx: AgentContext = {
    config,
    capturer,
    input,
    hub,
    pin,
    pinThrottle,
    regionWatcher,
    screen,
    displays,
    videoAvailable,
    video,
    get activeDisplay() {
      return activeDisplay;
    },
    controllers,
    addController(controller) {
      controllers.add(controller);
      log.info(`controller connected (${controllers.size} active)`);
      // The controller just passed token + PIN: wake the display so they can reach the lock screen
      // (and keep it on while they're connected). Synthetic input alone won't wake a slept panel.
      displayWake.setActive(true);
      for (const c of controllers) c.send({ type: "presence", watchers: controllers.size });
      controller.send({ type: "watchers", regions: regionWatcher.list() });
      updatePresence();
    },
    removeController(controller) {
      controllers.delete(controller);
      log.info(`controller disconnected (${controllers.size} active)`);
      // Last one out: let the display sleep & lock again for security.
      if (controllers.size === 0) displayWake.setActive(false);
      for (const c of controllers) c.send({ type: "presence", watchers: controllers.size });
      updatePresence();
      // Last controller gone: reset the shared crop so the NEXT session starts on the full screen.
      if (controllers.size === 0 && !isFullViewport(viewport)) {
        viewport = { x: 0, y: 0, w: 1, h: 1 };
        video?.setViewport(null);
      }
    },
    setVisibility(controller, visible) {
      controller.visible = visible;
    },
    setFps(next) {
      fps = Math.min(30, Math.max(1, Math.round(next)));
      log.debug(`capture fps -> ${fps}`);
    },
    selectDisplay(id) {
      if (!applyActiveDisplay(id)) return;
      viewport = { x: 0, y: 0, w: 1, h: 1 };
      video?.setDisplay(id); // re-target the H.264 encoders + reset zoom to full
      regionWatcher.resetBaselines(); // different display => new baselines
      const meta: ServerMessage = { type: "screen-meta", screen: { ...screen }, activeDisplay };
      for (const controller of controllers) {
        controller.send(meta);
        controller.send({ type: "screen-region", x: 0, y: 0, w: 1, h: 1 });
      }
      log.info(`active display -> [${id}]`);
    },
    requestFrame() {
      void captureOnce();
    },
    getViewport() {
      return { ...viewport };
    },
    setViewport(vp) {
      // Clamp to a sane sub-rectangle of the display so a bad client can't ask for nonsense.
      const w = clamp(vp.w, 0.05, 1);
      const h = clamp(vp.h, 0.05, 1);
      const x = clamp(vp.x, 0, 1 - w);
      const y = clamp(vp.y, 0, 1 - h);
      const next: Viewport = { x, y, w, h };
      const changed = next.x !== viewport.x || next.y !== viewport.y || next.w !== viewport.w || next.h !== viewport.h;
      viewport = next;
      // Re-encode the MAIN H.264 track to just this region (sharp + small); the client debounces.
      // Mark when the re-crop starts so onCropActive can report how long it took to go live.
      if (changed) cropRequestedAt = Date.now();
      video?.setViewport(isFullViewport(next) ? null : next);
      // Echo the REQUESTED region so controllers update the minimap/target right away; a second echo
      // with active:true follows from onCropActive once the new crop's first frame is on the wire.
      const meta: ServerMessage = { type: "screen-region", x: next.x, y: next.y, w: next.w, h: next.h };
      for (const controller of controllers) controller.send(meta);
    },
    addWatchRegion(region) {
      regionWatcher.add(region);
      for (const c of controllers) c.send({ type: "watchers", regions: regionWatcher.list() });
      ensureLoop();
    },
    removeWatchRegion(id) {
      regionWatcher.remove(id);
      for (const c of controllers) c.send({ type: "watchers", regions: regionWatcher.list() });
    },
    addTimer(msg) {
      const fireInMs = Math.max(1000, Math.min(msg.fireInMs, 7 * 24 * 3600_000)); // 1s .. 7 days
      const fireAtMs = Date.now() + fireInMs;
      // Re-adding the same id just updates its deadline; the shared ticker handles the rest.
      timers.set(msg.id, { id: msg.id, label: msg.label, fireAtMs, action: msg.action });
      ensureTimerTicker();
      broadcastTimers();
      log.info(`timer "${msg.label}" in ${Math.round(fireInMs / 1000)}s${msg.action ? ` (+${msg.action.kind})` : ""}`);
    },
    removeTimer(id) {
      if (!timers.delete(id)) return;
      broadcastTimers();
    },
    listTimers() {
      return listTimers();
    },
    async scanMonitors() {
      const sessions = await monitor.scan();
      const msg: ServerMessage = { type: "monitor-sessions", sessions };
      for (const c of controllers) c.send(msg);
    },
    addMonitor(msg) {
      monitor.addWatch({ id: msg.id, key: msg.key, agent: msg.agent, label: msg.label, events: msg.events });
    },
    removeMonitor(id) {
      monitor.removeWatch(id);
    },
    listMonitors() {
      return monitor.listMonitors();
    },
  };

  // Fan notifications out to every connected controller.
  hub.subscribe((notification) => {
    for (const controller of controllers) controller.send(notification);
  });

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: AGENT_VERSION });
  });

  app.get("/api/notifications", (_req, res) => {
    res.json(hub.getRecent());
  });

  app.post("/api/notify", (req, res) => {
    const { title, body, level, source } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ ok: false, error: "title (string) required" });
      return;
    }
    const notification = hub.emit({
      title,
      body: typeof body === "string" ? body : undefined,
      level: isLevel(level) ? level : "info",
      source: typeof source === "string" ? source : "webhook",
    });
    res.json({ ok: true, id: notification.id });
  });

  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
  } else {
    log.warn(`mobile-web build not found at ${webDist} — run "npm run build:web"`);
    app.get("/", (_req, res) =>
      res.status(503).send("WhipDesk: mobile-web is not built. Run `npm run build:web`."),
    );
  }

  const server = createServer(app);
  attachWebSocket(server, ctx);

  if (config.watchFile) {
    startFileWatcher(config.watchFile, config.watchRegex, hub);
  }

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  presence.start();
  if (config.keepAwake) keepAwake.start();
  log.info(`listening on :${config.port} (capture: ${capturer.backend}, input: ${input.name})`);
  log.info(pin.isSet ? "connection PIN: required" : "connection PIN: NONE (set one in a terminal)");
  return { server, config, presence, keepAwake, ctx };
}

function isLevel(value: unknown): value is "info" | "success" | "warning" | "error" {
  return value === "info" || value === "success" || value === "warning" || value === "error";
}

function logScreenPermissionHelp(): void {
  log.warn("macOS Screen Recording permission is required to capture the screen:");
  log.warn("  1) System Settings \u25b8 Privacy & Security \u25b8 Screen Recording");
  log.warn(
    '     CLI: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"',
  );
  log.warn("  2) Enable the app that runs the agent (VS Code or Terminal).");
  log.warn("  3) Fully quit + reopen that app, then run `npm run agent` again.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
