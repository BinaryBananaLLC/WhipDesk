import { Connection } from "./connection";
import { ConnectingOverlay } from "./connecting";
import { Controls } from "./controls";
import type { ControllerTransport } from "./core";
import { InputController } from "./input";
import { Notifications } from "./notifications";
import { PinPrompt } from "./pinPrompt";
import { registerPush } from "./push";
import { RemoteConnection, type FirebaseWebConfig } from "./remote";
import { ScreenView } from "./screen";
import { RegionWatchers } from "./watchers";
import { Whipository } from "./whipository";
import { dashboardUrl } from "./site";
import "./styles.css";

interface HashParams {
  token: string;
  remote: boolean;
  device: string;
}

function parseHash(): HashParams {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return {
    token: params.get("t") ?? params.get("token") ?? "",
    remote: params.get("remote") === "1" || params.has("device"),
    device: params.get("device") ?? params.get("d") ?? "",
  };
}

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Remote mode loads the Firebase web config hosted alongside the app (whipdesk.com). */
async function loadFirebaseConfig(): Promise<FirebaseWebConfig | null> {
  // Allow the host page to inject config directly, else fetch the static file.
  const injected = (window as unknown as { __WHIPDESK_FB__?: FirebaseWebConfig }).__WHIPDESK_FB__;
  if (injected?.apiKey) return injected;
  try {
    const res = await fetch("firebase.json", { cache: "no-store" });
    if (res.ok) return (await res.json()) as FirebaseWebConfig;
  } catch {
    /* not in remote-capable hosting */
  }
  return null;
}

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

const canvas = el("canvas", "wd-screen") as HTMLCanvasElement;
canvas.id = "wd-screen";
const toasts = el("div", "wd-toasts");
app.append(canvas, toasts);

const { token, remote, device } = parseHash();
const view = new ScreenView(canvas);
const notifications = new Notifications(toasts);
const pinPrompt = new PinPrompt(app);
// The dashboard escape hatch only makes sense when the user CAME from the dashboard (cloud
// remote session); a LAN controller has no machine list to go back to.
const connecting = new ConnectingOverlay(app, { dashboardEscape: remote && !!device });

async function makeTransport(remoteConfig: FirebaseWebConfig | null): Promise<ControllerTransport> {
  if (remote && device) {
    if (remoteConfig) return new RemoteConnection(device, token, remoteConfig);
    notifications.show({
      type: "notification",
      id: "no-fb",
      title: "Remote unavailable",
      body: "Firebase config not found for remote mode.",
      level: "error",
      source: "client",
      t: Date.now(),
    });
  }
  return new Connection(getWsUrl(), token);
}

async function start(): Promise<void> {
  const remoteConfig = remote && device ? await loadFirebaseConfig() : null;
  const conn = await makeTransport(remoteConfig);
  const input = new InputController(canvas, view, conn);
  // Notification permission is requested on a clear gesture (creating the first alert/timer), not
  // abruptly on load — Android Chrome ignores non-gesture requests, which is why the site never
  // appeared in the browser's notification settings. In remote mode this also wires FCM for
  // background delivery when the PWA is closed.
  const requestNotifications = () =>
    remoteConfig ? registerPush(remoteConfig, notifications) : notifications.requestPermission();
  // Whipository: reusable saved prompts. Cloud sessions sync to the user's account (one lazy
  // Firestore read/session + debounced writes); LAN keeps them in this browser only.
  const whipository = new Whipository(app!, notifications, remoteConfig);
  const watchers = new RegionWatchers(app!, conn, view, notifications, requestNotifications, whipository);
  const controls = new Controls(app!, { conn, view, input, notifications, watchers, whipository });

  // Hidden <video> sink for the single WebRTC desktop track. The ScreenView draws from it, so
  // zoom/pan/cursor all keep working; it stays display:none and feeds the canvas.
  const videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.setAttribute("playsinline", "");
  videoEl.style.display = "none";
  app!.append(videoEl);

  // A second hidden <video> for the low-res full-desktop overview track (frames flow only while the
  // main track is cropped). ScreenView snapshots it for the minimap + the pan/zoom base layer, so
  // those stay live even after the desktop changes while you're zoomed in (e.g. alt-tab).
  const overviewEl = document.createElement("video");
  overviewEl.muted = true;
  overviewEl.autoplay = true;
  overviewEl.playsInline = true;
  overviewEl.setAttribute("playsinline", "");
  overviewEl.style.display = "none";
  app!.append(overviewEl);

  let welcomed = false;
  // True while a foreground-resume reconnect is in flight, so the status handler shows the
  // "Reconnecting…" overlay for it (ordinary mid-session blips stay silent to avoid flicker).
  let resuming = false;
  // Last region we asked the host to crop to (null = none sent yet / full). Compared RELATIVE to its
  // own size so a pan is re-cropped whenever it moves meaningfully for the current zoom.
  let lastSent: { x: number; y: number; w: number; h: number } | null = null;
  let viewportTimer = 0;
  const isFullRegion = (r: { w: number; h: number }) => r.w >= 0.999 && r.h >= 0.999;
  // Closed-loop crop sync. `set-viewport` rides a best-effort channel (silently dropped on a
  // hiccup), so a fire-and-forget request can vanish while `lastSent` swears it was delivered —
  // the host then keeps streaming the WRONG region and the ±tol dedup below blocks every retry
  // until the user pans far enough away. The host echoes every region it APPLIES (screen-region);
  // track that echo and re-send a request the host never confirmed.
  let hostRegion: { x: number; y: number; w: number; h: number } | null = null;
  let lastSendAt = 0;
  let resendCount = 0;
  // A re-crop was requested but its first sharp frame isn't live yet (no active echo). Drives the
  // tiny "updating view…" pill so a slow/recovering encoder reads as progress, not a broken zoom.
  let awaitingActive = false;
  let cropAskedAt = 0;

  const sharpPill = document.createElement("div");
  sharpPill.className = "wd-sharpen hidden";
  sharpPill.setAttribute("aria-label", "updating view");
  app!.append(sharpPill);
  const hideSharpPill = () => {
    awaitingActive = false;
    sharpPill.classList.add("hidden");
  };

  const sendViewport = (r: { x: number; y: number; w: number; h: number }) => {
    // A region that covers almost the whole desktop IS the full desktop — so zooming out always
    // lands back on the uncropped screen instead of getting stuck on a near-full crop.
    const next = r.w >= 0.92 && r.h >= 0.92 ? { x: 0, y: 0, w: 1, h: 1 } : r;
    const full = isFullRegion(next);
    if (lastSent) {
      if (full && isFullRegion(lastSent)) return; // already showing the whole desktop
      if (!full) {
        // Re-crop only when the region shifted/zoomed enough to matter RELATIVE to its own size.
        // An absolute threshold (the old 0.01 quantize) is far too coarse when zoomed: at 8x the
        // whole visible strip is ~0.12 wide, so a real pan rounds to "no change" and the sharp crop
        // never follows the finger. Scaling the tolerance to the visible size fixes that while still
        // swallowing sub-pixel jitter (each re-crop restarts ffmpeg, so we don't want to thrash it).
        const tol = 0.08;
        if (
          Math.abs(next.x - lastSent.x) < next.w * tol &&
          Math.abs(next.y - lastSent.y) < next.h * tol &&
          Math.abs(next.w - lastSent.w) < next.w * tol &&
          Math.abs(next.h - lastSent.h) < next.h * tol
        )
          return;
      }
    }
    lastSent = next;
    lastSendAt = Date.now();
    resendCount = 0;
    // Pending only when this actually changes the host's crop (a matching echo means nothing to
    // wait for — e.g. the fit re-assert on connect), so the pill can't stick on a no-op request.
    awaitingActive = !hostRegion || !regionsAgree(next, hostRegion);
    if (awaitingActive) cropAskedAt = Date.now();
    conn.send({ type: "set-viewport", x: next.x, y: next.y, w: next.w, h: next.h });
  };

  // The reconcile loop: once a second, if the host's last CONFIRMED region isn't what we asked for
  // and our request has had time to land, ask again. A single lost/unapplied set-viewport now heals
  // in ~1s instead of leaving the host cropping the wrong part of the screen indefinitely. Bounded
  // retries so two controllers that genuinely disagree can't thrash the encoder forever (the count
  // resets whenever the user pans/zooms again or the host converges).
  const regionsAgree = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) =>
    Math.abs(a.x - b.x) < 0.005 &&
    Math.abs(a.y - b.y) < 0.005 &&
    Math.abs(a.w - b.w) < 0.005 &&
    Math.abs(a.h - b.h) < 0.005;
  window.setInterval(() => {
    // Show the pending pill only once a request has been outstanding >1.2s (instant re-crops never
    // flash it) and give up after 30s (an ancient agent that never sends active echoes).
    const waited = Date.now() - cropAskedAt;
    sharpPill.classList.toggle("hidden", !(awaitingActive && waited > 1200 && waited < 30_000));
    if (!lastSent || !hostRegion) return;
    if (regionsAgree(hostRegion, lastSent)) {
      resendCount = 0;
      return;
    }
    if (Date.now() - lastSendAt < 1200) return; // request (or retry) still in flight
    if (resendCount >= 3) return; // persistent disagreement — another controller drives; yield
    resendCount += 1;
    lastSendAt = Date.now();
    conn.send({ type: "set-viewport", x: lastSent.x, y: lastSent.y, w: lastSent.w, h: lastSent.h });
  }, 1000);

  // As the user zooms/pans, ask the host to crop the desktop track to just the visible region
  // (sharp, native-res). The ScreenView tracks the gesture instantly (digital zoom of the current
  // frame); the host is only asked to RE-CROP once the interaction SETTLES. Every re-crop restarts
  // ffmpeg on the host, and a swipe burst that restarts it once per swipe drives macOS screen
  // capture into a zero-frame state that takes tens of seconds to clear — so a finger landing
  // during the settle window HOLDS the pending request, and only the last lift of a swipe
  // sequence (followed by a quiet settle period) sends ONE request for where the view ended up.
  // The region is read at SEND time, so the request is always the freshest view. Returning to fit
  // is immediate. The host echoes `screen-region`, which ScreenView uses to place the frame at
  // exactly its desktop rectangle (no stretch).
  const VIEWPORT_SETTLE_MS = 400;
  let viewChangedThisGesture = false;
  let sendHeldByGesture = false;
  const scheduleViewportSend = () => {
    const z = view.getZoom() > 1.01;
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(
      () => {
        viewportTimer = 0;
        sendViewport(view.getZoom() > 1.01 ? view.getVisibleRegion() : { x: 0, y: 0, w: 1, h: 1 });
      },
      z ? VIEWPORT_SETTLE_MS : 0,
    );
  };
  view.setOnView(() => {
    viewChangedThisGesture = true;
    scheduleViewportSend();
  });
  view.setOnGesture((active) => {
    if (active) {
      sendHeldByGesture = viewportTimer !== 0;
      if (sendHeldByGesture) {
        window.clearTimeout(viewportTimer);
        viewportTimer = 0;
      }
      viewChangedThisGesture = false;
    } else if (!viewChangedThisGesture && sendHeldByGesture) {
      // The gesture that held a pending send turned out to be a tap (view unchanged) — re-arm
      // the held request so it's never silently lost.
      sendHeldByGesture = false;
      scheduleViewportSend();
    }
  });

  conn.on("status", (s) => {
    controls.setStatus(s);
    // Overlay shows during the FIRST connect (playful rotating copy) and during a foreground-resume
    // reconnect (steady "Reconnecting…"). We keep it up across the whole connecting⇄disconnected
    // retry cycle (so it doesn't strobe on a flaky link) and drop it only once we're connected.
    // Ordinary post-welcome blips stay silent — the status pill covers those.
    if (s === "connected") {
      resuming = false;
      connecting.hide();
    } else if (!welcomed || resuming) {
      connecting.show(welcomed ? "Reconnecting…" : undefined);
    }
    if (s === "disconnected") {
      lastSent = null;
      hostRegion = null;
      hideSharpPill();
    }
  });
  conn.on("transport", (t) => controls.setTransport(t));
  conn.on("welcome", (w) => {
    const firstWelcome = !welcomed;
    welcomed = true;
    connecting.hide();
    pinPrompt.hide();
    view.setScreen(w.screen);
    controls.setWelcome(w);
    // On the FIRST connect, start at fit (1×) and clear any leftover server-side crop.
    if (firstWelcome) {
      view.setZoom(1);
      lastSent = null;
      sendViewport({ x: 0, y: 0, w: 1, h: 1 });
    } else {
      // Session REBUILT (resume/reconnect): the host's crop is whatever ITS state says now — e.g.
      // reset to full when we were briefly its last controller — not what we last asked for. Drop
      // the dedup memory and re-assert the current view, otherwise a pan back into ±tol of the
      // stale `lastSent` is swallowed as "already sent" and the sharp crop never returns.
      lastSent = null;
      window.clearTimeout(viewportTimer);
      viewportTimer = 0;
      sendViewport(view.getZoom() > 1.01 ? view.getVisibleRegion() : { x: 0, y: 0, w: 1, h: 1 });
    }
  });
  conn.on("versionMismatch", (m) => showAgentOutdatedBanner(m.agentVersion));
  conn.on("pinRequired", (req) => {
    connecting.hide();
    pinPrompt.show(req, (pin) => conn.submitPin(pin));
  });
  conn.on("presence", (count) => controls.setPresence(count));
  // Live rename echo: the agent broadcasts the new display name to every connected controller.
  conn.on("machineName", (name) => controls.setDeviceName(name));
  let regionCount = 0;
  let timerCount = 0;
  let monitorCount = 0;
  const refreshAlertCount = () => controls.setAlertCount(regionCount + timerCount + monitorCount);
  conn.on("watchers", (regions) => {
    regionCount = regions.length;
    watchers.setRegions(regions);
    refreshAlertCount();
  });
  conn.on("timers", (timers) => {
    timerCount = timers.length;
    watchers.setTimers(timers);
    refreshAlertCount();
  });
  conn.on("monitors", (monitors) => {
    monitorCount = monitors.length;
    watchers.setMonitors(monitors);
    refreshAlertCount();
  });
  conn.on("monitorAlways", (agents) => {
    watchers.setAlwaysAgents(agents);
  });
  // The host echoes which region the track is now cropped to; null/full = whole desktop. The
  // REQUESTED echo updates the minimap/target immediately; the ACTIVE echo (sent once the new crop's
  // first frame is on the wire) is when ScreenView actually moves the displayed frame onto it.
  conn.on("screenRegion", (r) => {
    // Every echo is the host's AUTHORITATIVE crop state — the reconcile loop compares it against
    // what we asked for and re-sends when the host never got the request.
    hostRegion = { x: r.x, y: r.y, w: r.w, h: r.h };
    if (r.active) hideSharpPill(); // the (re)cropped stream is live — sharp frames are arriving
    const region = isFullRegion(r) ? null : r;
    if (r.active) view.setFrameRegionActive(region);
    else view.setFrameRegion(region);
  });
  // The single desktop track (full desktop, or the host's sharp crop when zoomed).
  conn.on("videoTrack", (stream) => {
    if (!stream) {
      videoEl.srcObject = null;
      view.setVideoSource(null);
      return;
    }
    videoEl.srcObject = stream;
    void videoEl.play().catch(() => {
      /* autoplay may need a gesture */
    });
    view.setVideoSource(videoEl);
  });
  // The low-res full-desktop overview track (live only while the main track is cropped).
  conn.on("overviewTrack", (stream) => {
    if (!stream) {
      overviewEl.srcObject = null;
      view.setOverviewSource(null);
      return;
    }
    overviewEl.srcObject = stream;
    void overviewEl.play().catch(() => {
      /* autoplay may need a gesture */
    });
    view.setOverviewSource(overviewEl);
  });
  conn.on("netStats", ({ fps, rtt }) => controls.setNetStats(fps, rtt));
  conn.on("screenMeta", ({ screen, activeDisplay }) => {
    view.setScreen(screen);
    if (activeDisplay !== undefined) controls.setActiveDisplay(activeDisplay);
  });
  conn.on("notification", (n) => notifications.show(n));
  conn.on("error", (message) => controls.flashError(message));

  // Returning users who already granted notifications: refresh their FCM token so background push
  // keeps working. First-time permission is requested later, from a real gesture (creating an
  // alert/timer) — see requestNotifications.
  if (remoteConfig) {
    let pushReady = false;
    conn.on("welcome", () => {
      if (pushReady || notifications.permission !== "granted") return;
      pushReady = true;
      void registerPush(remoteConfig, notifications);
    });
  }

  // Pause host capture while hidden (battery), and — crucially on mobile — proactively rebuild the
  // WebRTC link when we return. A backgrounded tab gets its peer connection frozen or killed, often
  // with no state-change event firing, so waiting on the passive reconnect backoff can leave the
  // screen stuck on a dead frame (the "had to go back to the dashboard and come back" case). The
  // extra `pageshow` covers bfcache restores that skip visibilitychange.
  const resumeIfNeeded = () => {
    if (document.hidden || conn.isHealthy()) return;
    resuming = true;
    connecting.show("Reconnecting…");
    conn.wake();
  };
  document.addEventListener("visibilitychange", () => {
    conn.setVisible(!document.hidden);
    if (!document.hidden) resumeIfNeeded();
  });
  window.addEventListener("pageshow", resumeIfNeeded);
  // Real unload (refresh/navigate-away, not a bfcache freeze): close the session gracefully so the
  // agent drops us from its viewer count immediately instead of waiting out the ICE consent
  // timeout. bfcache restores re-enter via pageshow → resumeIfNeeded, which rebuilds the link.
  window.addEventListener("pagehide", (e) => {
    if (!e.persisted) conn.close();
  });

  // Back-button guard (remote/dashboard sessions only): a single Back used to silently drop the
  // session and bounce to the dashboard. Trap it with a confirm dialog so a stray swipe/back doesn't
  // yank you off a live machine — Cancel stays put; Disconnect (or pressing Back a second time)
  // leaves. LAN has no dashboard to return to, so it's not armed there.
  if (remote && device) setupBackGuard(conn, app!);

  if (!token) {
    controls.flashError("No pairing token in the URL (#t=…). Re-open the link/QR from the agent.");
  }
  conn.connect();
}

void start();

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * Intercept the browser Back button with a confirm dialog instead of dropping the session outright.
 *
 * Mechanics: we keep one extra "trap" history entry ahead of the page. The first Back pops it and
 * fires popstate — we show the dialog and immediately push a fresh trap, so a SECOND Back is caught
 * too. While the dialog is up, that second Back (or the Disconnect button) actually leaves;
 * Cancel just closes the dialog and we stay put. Everything is one SPA page, so no real navigation
 * happens until the user confirms.
 */
function setupBackGuard(conn: ControllerTransport, app: HTMLElement): void {
  let dialog: HTMLElement | null = null;
  let armed = false; // the confirm dialog is showing, waiting for a 2nd Back / a button
  const trap = () => history.pushState({ wdBackGuard: true }, "");

  const leave = () => {
    armed = false;
    conn.close();
    window.location.replace(dashboardUrl()); // replace so the trap entries don't linger
  };

  const build = (): HTMLElement => {
    const overlay = el("div", "wd-dialog-overlay wd-backguard hidden");
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    const h2 = document.createElement("h2");
    h2.textContent = "Disconnect from this machine?";
    head.appendChild(h2);
    const help = el("p", "wd-dialog-help");
    help.textContent = "You'll go back to your dashboard. Press back again to disconnect.";
    const actions = el("div", "wd-dialog-actions");
    const cancel = document.createElement("button");
    cancel.className = "wd-btn";
    cancel.textContent = "Cancel";
    cancel.onclick = hide;
    const disconnect = document.createElement("button");
    disconnect.className = "wd-btn wd-danger";
    disconnect.textContent = "Disconnect";
    disconnect.onclick = leave;
    actions.append(cancel, disconnect);
    card.append(head, help, actions);
    overlay.appendChild(card);
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) hide();
    });
    app.appendChild(overlay);
    return overlay;
  };

  const show = () => {
    if (!dialog) dialog = build();
    dialog.classList.remove("hidden");
    armed = true;
    trap(); // re-arm: keep a trap entry ahead so a second Back re-enters popstate
  };
  function hide(): void {
    dialog?.classList.add("hidden");
    armed = false;
  }

  trap(); // initial trap entry
  window.addEventListener("popstate", () => {
    if (armed) leave();
    else show();
  });
}

/**
 * Persistent nudge shown when the connected agent speaks an older wire protocol than this
 * (always-fresh) client — i.e. the local agent build is behind. Self-contained (inline styles,
 * de-duped by id) so it works on both the LAN and remote paths without touching the app chrome.
 */
function showAgentOutdatedBanner(agentVersion?: string): void {
  const id = "wd-outdated-banner";
  if (document.getElementById(id)) return;
  const bar = document.createElement("div");
  bar.id = id;
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7a2e00;color:#fff;" +
    "font:14px/1.4 system-ui,sans-serif;padding:10px 40px 10px 14px;text-align:center;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.35)";
  const ver = agentVersion ? ` (agent ${agentVersion})` : "";
  bar.innerHTML =
    `⚠️ This WhipDesk agent${ver} is out of date. ` +
    `Update from <a style="color:#ffd9a6" href="https://github.com/BinaryBananaLLC/WhipDesk/releases/latest" ` +
    `target="_blank" rel="noreferrer noopener">the latest release</a> or run <code>npm i -g whipdesk@latest</code>.`;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.style.cssText =
    "position:absolute;right:8px;top:6px;background:none;border:none;color:#fff;font-size:16px;cursor:pointer";
  close.onclick = () => bar.remove();
  bar.appendChild(close);
  document.body.appendChild(bar);
}
