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
const connecting = new ConnectingOverlay(app);

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
  const watchers = new RegionWatchers(app!, conn, view, notifications, requestNotifications);
  const controls = new Controls(app!, { conn, view, input, notifications, watchers });

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
  let lastViewport = "";
  let viewportTimer = 0;
  const isFullRegion = (r: { w: number; h: number }) => r.w >= 0.999 && r.h >= 0.999;

  const sendViewport = (r: { x: number; y: number; w: number; h: number }) => {
    // A region that covers almost the whole desktop IS the full desktop — so zooming out always
    // lands back on the uncropped screen instead of getting stuck on a near-full crop.
    const next = r.w >= 0.92 && r.h >= 0.92 ? { x: 0, y: 0, w: 1, h: 1 } : r;
    // Quantize to ~2% so tiny pan jitter doesn't keep re-cropping (each re-crop restarts ffmpeg).
    const q = `${next.x.toFixed(2)},${next.y.toFixed(2)},${next.w.toFixed(2)},${next.h.toFixed(2)}`;
    if (q === lastViewport) return;
    lastViewport = q;
    conn.send({ type: "set-viewport", x: next.x, y: next.y, w: next.w, h: next.h });
  };

  // As the user zooms/pans, ask the host to crop the desktop track to just the visible region
  // (sharp, native-res). The ScreenView tracks the gesture instantly (digital zoom of the current
  // frame); we only ask the host to RE-CROP once the gesture is RELEASED — ScreenView gates this
  // callback behind begin/endViewGesture, so a pinch/pan never re-crops mid-drag (which could land a
  // stale crop). Discrete zoom-button taps fire outside a gesture and coalesce via a short debounce.
  // Returning to fit is immediate. The host echoes `screen-region`, which ScreenView uses to place
  // the frame at exactly its desktop rectangle (no stretch).
  view.setOnView((region) => {
    const z = view.getZoom() > 1.01;
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(() => sendViewport(z ? region : { x: 0, y: 0, w: 1, h: 1 }), z ? 120 : 0);
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
    if (s === "disconnected") lastViewport = "";
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
      lastViewport = "0.000,0.000,1.000,1.000";
      view.setZoom(1);
      conn.send({ type: "set-viewport", x: 0, y: 0, w: 1, h: 1 });
    }
  });
  conn.on("pinRequired", (req) => {
    connecting.hide();
    pinPrompt.show(req, (pin) => conn.submitPin(pin));
  });
  conn.on("presence", (count) => controls.setPresence(count));
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
  // The host echoes which region the track is now cropped to; null/full = whole desktop. The
  // REQUESTED echo updates the minimap/target immediately; the ACTIVE echo (sent once the new crop's
  // first frame is on the wire) is when ScreenView actually moves the displayed frame onto it.
  conn.on("screenRegion", (r) => {
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
