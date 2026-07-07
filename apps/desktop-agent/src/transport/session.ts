import { randomUUID, timingSafeEqual } from "node:crypto";
import { platform } from "node:os";
import {
  PROTOCOL_VERSION,
  isClientMessage,
  type ClientMessage,
  type ServerMessage,
  type WelcomeMessage,
} from "@whipdesk/protocol";
import { AGENT_VERSION } from "../config";
import { log } from "../logger";
import type { CaptureOptions } from "../capture/screen";
import { toDisplayInfo } from "../capture/displays";
import type { AgentContext, Controller } from "../server";

/**
 * Transport-neutral channel. WebSocket and WebRTC each adapt their socket/data-channel to
 * this, so the controller handshake (token + PIN) and input dispatch live in one place.
 */
export interface RawChannel {
  sendText(text: string): void;
  close(reason?: string): void;
}

export interface ControllerSession {
  /** Feed an inbound text frame (JSON control message). */
  handleText(raw: string): void;
  /** Tear down (socket closed). Idempotent. */
  handleClose(): void;
}

/** Per-connection metadata the transport knows (used for brute-force throttling). */
export interface SessionOptions {
  /** Stable-ish client identity: LAN IP for WebSocket, controller uid for WebRTC. */
  clientId?: string;
  /**
   * Fired EXACTLY when the controller passes the token + PIN gate (in `admit()`), and never
   * before. The WebRTC transport uses this to attach the screen video tracks only after auth, so
   * not a single frame of the desktop streams while the PIN dialog is still up.
   */
  onAuthenticated?: () => void;
}

/** Constant-time string compare that never short-circuits on length or content. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) {
    // Still run a compare against a same-length buffer so timing doesn't leak the length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Runs the controller protocol over any `RawChannel`: token gate → optional PIN
 * challenge/response (per-connection countdown + a persistent, cross-reconnect lockout via
 * `ctx.pinThrottle`) → `welcome` → input dispatch. The returned session is fed inbound text
 * frames by the transport.
 */
export function createControllerSession(
  ctx: AgentContext,
  channel: RawChannel,
  opts: SessionOptions = {},
): ControllerSession {
  let controller: Controller | null = null;
  let phase: "hello" | "pin" = "hello";
  let nonce = "";
  let attemptsLeft = 5;
  let closed = false;
  const clientId = opts.clientId;

  const send = (msg: ServerMessage) => channel.sendText(JSON.stringify(msg));

  const sendAuthChallenge = () => {
    nonce = ctx.pin.issueNonce();
    send({
      type: "auth-required",
      salt: ctx.pin.salt,
      iterations: ctx.pin.iterations,
      nonce,
      attemptsLeft,
    });
  };

  const admit = () => {
    ctx.pinThrottle.recordSuccess(clientId);
    controller = {
      id: randomUUID(),
      visible: true,
      send,
      close: (_code, reason) => channel.close(reason),
    };
    ctx.addController(controller);
    // Only NOW is the controller authorized to see the screen — start the video tracks.
    opts.onAuthenticated?.();
    controller.send(buildWelcome(ctx));
    // Tell the new controller which sub-region (if any) the host is currently cropping to.
    const vp = ctx.getViewport();
    controller.send({ type: "screen-region", x: vp.x, y: vp.y, w: vp.w, h: vp.h });
  };

  const handleClose = () => {
    if (closed) return;
    closed = true;
    if (controller) {
      ctx.removeController(controller);
      controller = null;
    }
  };

  const handleText = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isClientMessage(parsed)) return;
    const msg = parsed as ClientMessage;

    if (!controller && phase === "hello") {
      if (msg.type !== "hello") return channel.close("expected hello");
      if (!safeEqual(msg.token, ctx.config.token)) {
        log.warn("rejected controller: invalid token");
        send({ type: "error", message: "invalid token", code: "auth" });
        return channel.close("invalid token");
      }
      if (ctx.pin.isSet) {
        // Persistent lockout check BEFORE issuing a challenge, so a locked-out client can't
        // even start guessing again by reconnecting.
        const gate = ctx.pinThrottle.check(clientId);
        if (gate.locked) {
          log.warn(`rejected controller: PIN locked out (${Math.ceil(gate.retryAfterMs / 1000)}s left)`);
          send({ type: "error", message: "too many PIN attempts", code: "pin-locked", retryAfterMs: gate.retryAfterMs });
          return channel.close("pin-locked");
        }
        phase = "pin";
        sendAuthChallenge();
        return;
      }
      admit();
      return;
    }

    if (!controller && phase === "pin") {
      if (msg.type !== "auth") return channel.close("expected auth");
      if (ctx.pin.verify(nonce, msg.response)) {
        admit();
        return;
      }
      attemptsLeft -= 1;
      const verdict = ctx.pinThrottle.recordFailure(clientId);
      log.warn(`rejected controller: wrong PIN (${attemptsLeft} attempts left this connection)`);
      if (verdict.locked || attemptsLeft <= 0) {
        send({
          type: "error",
          message: "too many PIN attempts",
          code: "pin-locked",
          retryAfterMs: verdict.retryAfterMs || undefined,
        });
        return channel.close("pin");
      }
      send({ type: "error", message: "wrong PIN", code: "pin" });
      sendAuthChallenge();
      return;
    }

    if (!controller) return;
    void dispatch(ctx, msg, controller).catch((error) => {
      log.error("input error", (error as Error).message);
      controller?.send({ type: "error", message: (error as Error).message, code: "input" });
    });
  };

  return { handleText, handleClose };
}

function buildWelcome(ctx: AgentContext): WelcomeMessage {
  return {
    type: "welcome",
    protocol: PROTOCOL_VERSION,
    agent: { version: AGENT_VERSION, platform: platform(), hostname: ctx.getMachineName(), hdr: ctx.hdrActive || undefined },
    screen: ctx.screen,
    capture: { fps: ctx.config.fps, quality: ctx.config.quality, maxWidth: ctx.config.maxWidth },
    capabilities: {
      mouse: ctx.input.canMouse,
      keyboard: ctx.input.canKeyboard,
      capture: ctx.capturer.backend,
      region: ctx.capturer.canCrop,
      video: ctx.videoAvailable,
      monitor: true,
    },
    displays: ctx.displays.map(toDisplayInfo),
    activeDisplay: ctx.activeDisplay,
    watchers: ctx.regionWatcher.list(),
    timers: ctx.listTimers(),
    monitors: ctx.listMonitors(),
    alwaysAgents: ctx.listAlwaysAgents(),
    notifications: ctx.hub.getRecent(),
  };
}

async function dispatch(ctx: AgentContext, msg: ClientMessage, controller: Controller): Promise<void> {
  switch (msg.type) {
    case "pointer":
      if (msg.action === "move") await ctx.input.moveTo(msg.x ?? 0, msg.y ?? 0);
      else if (msg.action === "down") await ctx.input.buttonDown(msg.button ?? "left", msg.x, msg.y);
      else if (msg.action === "up") await ctx.input.buttonUp(msg.button ?? "left");
      else if (msg.action === "click")
        await ctx.input.click(msg.button ?? "left", Boolean(msg.double), msg.x, msg.y);
      break;
    case "scroll":
      await ctx.input.scroll(msg.dx, msg.dy);
      break;
    case "key":
      await ctx.input.keyTap(msg.key, msg.modifiers);
      break;
    case "type":
      await ctx.input.typeText(msg.text, msg.submit);
      break;
    case "set-quality": {
      const patch: Partial<CaptureOptions> = {};
      if (typeof msg.quality === "number") patch.quality = msg.quality;
      if (typeof msg.maxWidth === "number") patch.maxWidth = msg.maxWidth;
      ctx.capturer.setOptions(patch);
      if (typeof msg.fps === "number") ctx.setFps(msg.fps);
      break;
    }
    case "set-viewport":
      ctx.setViewport({ x: msg.x, y: msg.y, w: msg.w, h: msg.h });
      break;
    case "request-frame":
      ctx.requestFrame();
      break;
    case "select-display":
      ctx.selectDisplay(msg.id);
      break;
    case "watch-add":
      ctx.addWatchRegion(msg.region);
      break;
    case "watch-remove":
      ctx.removeWatchRegion(msg.id);
      break;
    case "timer-add":
      ctx.addTimer(msg);
      break;
    case "timer-remove":
      ctx.removeTimer(msg.id);
      break;
    case "monitor-scan":
      await ctx.scanMonitors();
      break;
    case "monitor-add":
      ctx.addMonitor(msg);
      break;
    case "monitor-remove":
      ctx.removeMonitor(msg.id);
      break;
    case "monitor-always":
      ctx.setAlwaysAgent(msg.agent, msg.enabled);
      break;
    case "visibility":
      ctx.setVisibility(controller, msg.visible);
      break;
    case "rename-machine":
      ctx.setMachineName(msg.name);
      break;
    case "video-stats":
      ctx.reportVideoStats(msg.lossPct, msg.rttMs);
      break;
    case "ping":
      controller.send({ type: "pong", t: msg.t });
      break;
    case "hello":
    case "auth":
      break;
  }
}
