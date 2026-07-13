/**
 * WhipDesk wire protocol.
 *
 * AI-AGENT NOTES (read me before editing):
 * - This package is TYPES ONLY. It must contain zero runtime side effects so it
 *   can be `import type`-erased by both the agent (tsx/esbuild) and the web app (Vite).
 * - The transport is a bidirectional message channel (WebSocket on LAN, WebRTC
 *   DataChannel for remote — see docs/ARCHITECTURE.md). Both carry the SAME
 *   messages defined here.
 * - CONTROL messages are JSON text frames; every message has a `type` field. The desktop
 *   screen reaches the controller as a WebRTC H.264 video track, not over this channel.
 * - Pointer coordinates are ALWAYS normalized to [0,1] relative to the full desktop
 *   screen, never pixels — resolution-independent and immune to Retina/HiDPI scaling.
 *   The agent multiplies by the logical screen size before injecting input.
 */

export const PROTOCOL_VERSION = 2 as const;

/** Default network + capture values. This is the source of truth; agent config reads these. */
export const DEFAULTS = {
  PORT: 8787,
  FPS: 10,
  // Higher quality + resolution so on-screen text stays readable when zoomed.
  JPEG_QUALITY: 75,
  MAX_WIDTH: 2048,
  /** Live H.264 capture framerate (the wire codec is a single WebRTC video track). */
  VIDEO_FPS: 30,
  /** Target bitrate (kbps) for the MAIN (full/zoomed) H.264 track. */
  VIDEO_KBPS: 4000,
  // Low-res full-desktop "overview" for the minimap + the base layer under a pan/zoom. While the
  // main track is CROPPED (zoomed), the host emits this as a SECOND H.264 track from the SAME
  // ffmpeg via a `split` filter (one capture, two encodes — never a 2nd screen grab, which fights
  // the live avfoundation encoder on macOS). Uncropped, there's no overview track — the main track
  // already IS the whole desktop, so the controller snapshots that instead.
  OVERVIEW_WIDTH: 480,
  OVERVIEW_FPS: 2,
  OVERVIEW_KBPS: 150,
} as const;

export type MouseButton = "left" | "right" | "middle";
export type PointerAction = "move" | "down" | "up" | "click";

/** RustDesk-inspired control mode for the mobile client. */
export type InputMode = "absolute" | "trackpad";

/** How the mobile client renders the desktop. */
export type ViewMode = "fit" | "magnify";

/**
 * A screen region the host watches for visual change. Coordinates are normalized [0,1] of
 * the active display. When the pixels inside change, the host fires a `notification`.
 */
export interface WatchRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A capturable display on the host. Sizes are logical points (not pixels). */
export interface DisplayInfo {
  /** 0-based index understood by the capture + input backends. */
  id: number;
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Session monitoring (zero-config AI-agent watching).
// ---------------------------------------------------------------------------

/** AI coding agents the host can auto-detect from running processes. */
export type AgentKind =
  | "claude"
  | "codex"
  | "gemini"
  | "aider"
  | "copilot"
  | "opencode"
  | "cursor"
  | "amp"
  | "unknown";

/** Inferred run state of a monitored agent session. */
export type MonitorState = "working" | "blocked" | "idle" | "finished" | "crashed" | "unknown";

/** A live AI-agent session the host discovered by observing processes (no wrappers/hooks). */
export interface MonitorSessionInfo {
  /** Stable key (agent + project/tty) so a watch survives the process restarting. */
  key: string;
  agent: AgentKind;
  /** Human label, usually the project folder the agent is running in. */
  title: string;
  pid: number;
  state: MonitorState;
  /** True when a monitor is already watching this session. */
  watched?: boolean;
}

/**
 * An active session-monitoring auto-whip. There is a single notification behaviour: you're pinged
 * when the agent stops working — it's waiting on you (a question) or has gone idle/exited.
 */
export interface MonitorInfo {
  id: string;
  key: string;
  agent: AgentKind;
  label: string;
  state: MonitorState;
  /** False once the watched session is no longer running. */
  live: boolean;
}

// ---------------------------------------------------------------------------
// Client -> Agent (controller -> host)
// ---------------------------------------------------------------------------

/** First message a controller MUST send. Gates the connection by pairing token. */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  token: string;
  role: "controller";
  client?: {
    userAgent?: string;
    label?: string;
  };
}

/**
 * PIN challenge response. The controller proves it knows the device PIN without sending it:
 * key = stretch(pin, salt, iterations); response = sha256(key + ":" + nonce). The agent
 * compares against its stored key. See apps/desktop-agent/src/security/pin.ts.
 */
export interface AuthMessage {
  type: "auth";
  response: string;
}

/** Tells the host whether the controller is currently viewing (Page Visibility). */
export interface VisibilityMessage {
  type: "visibility";
  visible: boolean;
}

export interface PointerMessage {
  type: "pointer";
  action: PointerAction;
  /** Normalized [0,1] across the full desktop. Omitted for button-only events. */
  x?: number;
  y?: number;
  button?: MouseButton;
  /** When action === "click", whether it is a double click. */
  double?: boolean;
}

export interface ScrollMessage {
  type: "scroll";
  /** Wheel deltas. Positive dy scrolls down, positive dx scrolls right. */
  dx: number;
  dy: number;
}

/** A single key action (with optional modifiers), used for shortcuts/special keys. */
export interface KeyMessage {
  type: "key";
  /** Named key, e.g. "Enter", "Escape", "ArrowUp", "Backspace", "Tab", "a". */
  key: string;
  press?: "tap" | "down" | "up";
  /** e.g. ["control"], ["meta","shift"]. */
  modifiers?: string[];
}

/** Type a literal string; primary path for "send a prompt to the AI". */
export interface TypeMessage {
  type: "type";
  text: string;
  /** When true, press Enter after typing (submits the prompt). */
  submit?: boolean;
}

/** Adjust the live capture pipeline at runtime. */
export interface SetQualityMessage {
  type: "set-quality";
  fps?: number;
  quality?: number;
  maxWidth?: number;
}

/**
 * Tell the host to capture + send ONLY this sub-region of the active display, in normalized
 * [0,1] coordinates. Sent when the controller zooms/pans so the agent crops instead of
 * streaming the whole desktop — a large bandwidth win when magnified. A full-screen viewport
 * is `{ x: 0, y: 0, w: 1, h: 1 }` (or any w/h >= 1). The host clamps to the display, applies
 * it globally (most-recent-wins, like `set-quality`), and echoes the region it actually used
 * back via `screen-region` so the controller can place each cropped frame correctly.
 */
export interface SetViewportMessage {
  type: "set-viewport";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RequestFrameMessage {
  type: "request-frame";
}

/** Switch which display the host captures + injects input onto. */
export interface SelectDisplayMessage {
  type: "select-display";
  id: number;
}

/** Add a screen-region change watcher (fires a notification when those pixels change). */
export interface WatchAddMessage {
  type: "watch-add";
  region: WatchRegion;
}

/** Remove a screen-region watcher by id. */
export interface WatchRemoveMessage {
  type: "watch-remove";
  id: string;
}

/**
 * One step of a lash (a saved multi-step automation — see `Lash`). A single interface with a
 * `kind` discriminator + optional fields, mirroring `ScheduledAction`, so new step kinds
 * (scroll, drag, …) can be added without breaking older payloads. Coordinates are normalized
 * [0,1] of the display the lash was recorded on.
 */
export interface LashStep {
  kind: "click" | "text" | "key" | "wait" | "display";
  /** For kind "click": the target point. */
  x?: number;
  y?: number;
  button?: MouseButton;
  double?: boolean;
  /** For kind "text": the literal string to type. */
  text?: string;
  /** For kind "text": press Enter after typing (defaults to true — "send the prompt"). */
  submit?: boolean;
  /** For kind "key", e.g. "Enter", "Escape", "Tab". */
  key?: string;
  modifiers?: string[];
  /** For kind "wait": pause between steps, in ms. */
  ms?: number;
  /**
   * For kind "display": switch which monitor the FOLLOWING click steps target, so one lash can
   * click on several screens ("click on monitor 1 → change monitor → click on monitor 2"). The id
   * matches `DisplayInfo.id`; execution re-pins the input mapper to it. `displayName` is a
   * record-time label for the UI only (it never affects where clicks land).
   */
  displayId?: number;
  displayName?: string;
}

/**
 * A lash: a named, reusable input automation ("click 812,445 → type 'fix it' → Enter") kept in
 * the LashStash. Lashes live ON THE HOST (state dir, like timers) because their coordinates are
 * tied to that machine's screens — they survive agent updates and die with an uninstall, and are
 * deliberately NOT synced to the cloud. If displays/windows change since recording, execution is
 * allowed to fail loudly rather than click the wrong spot.
 */
export interface Lash {
  id: string;
  name: string;
  steps: LashStep[];
  /** Display the steps were recorded on; execution pins pointer mapping to it. */
  displayId?: number;
  /** Logical screen size when recorded — for showing human-readable px in the UI. */
  screen?: ScreenInfo;
  createdAt: number;
  updatedAt: number;
}

/** Caps enforced host-side when saving a lash (mirror them in client UIs). */
export const LASH_LIMITS = {
  MAX_LASHES: 50,
  MAX_STEPS: 30,
  MAX_NAME: 60,
  MAX_TEXT: 2000,
  MAX_WAIT_MS: 300_000,
} as const;

/**
 * Optional action the host performs when a timer fires (besides notifying). Lets a user schedule
 * an auto-click/keypress for when an AI tool's session cooldown ends — e.g. click "Retry" or send
 * a prompt the moment Claude/Copilot is available again. Coordinates are normalized [0,1].
 */
export interface ScheduledAction {
  kind: "click" | "key" | "text" | "steps";
  /** Target point for a click, or where to focus before a key/text action. */
  x?: number;
  y?: number;
  /** For kind "click". */
  button?: MouseButton;
  /** For kind "key", e.g. "Enter". */
  key?: string;
  /** For kind "text": typed, then submitted with Enter. */
  text?: string;
  /** For kind "steps": the lash step sequence to run (a snapshot — edits to the saved lash after
   * scheduling don't retroactively change what fires). */
  steps?: LashStep[];
  /** For kind "steps": display the steps were recorded on (overrides the scheduling display). */
  displayId?: number;
}

/** Schedule a one-shot reminder (and optional action) that fires `fireInMs` from now. */
export interface TimerAddMessage {
  type: "timer-add";
  id: string;
  fireInMs: number;
  label: string;
  action?: ScheduledAction;
}

/** Cancel a pending timer by id. */
export interface TimerRemoveMessage {
  type: "timer-remove";
  id: string;
}

/** Create or update (by id) a lash in the host's LashStash. The host echoes `lashes`. */
export interface LashSaveMessage {
  type: "lash-save";
  lash: Lash;
}

/** Delete a lash by id. The host echoes `lashes`. */
export interface LashRemoveMessage {
  type: "lash-remove";
  id: string;
}

/** Ask the host to (re)scan for running AI-agent sessions; it replies with `monitor-sessions`. */
export interface MonitorScanMessage {
  type: "monitor-scan";
}

/** Start monitoring a discovered session. Fires once when the agent stops working. */
export interface MonitorAddMessage {
  type: "monitor-add";
  id: string;
  key: string;
  agent: AgentKind;
  label: string;
}

/** Stop a session monitor by id. */
export interface MonitorRemoveMessage {
  type: "monitor-remove";
  id: string;
}

/**
 * Turn the "always alert" mode on/off for a whole agent kind. When enabled, the host monitors every
 * running session of that kind and pings you when it stops working — persisted, so it keeps working
 * across agent and WhipDesk restarts with no need to re-add a monitor.
 */
export interface MonitorAlwaysMessage {
  type: "monitor-always";
  agent: AgentKind;
  enabled: boolean;
}

/**
 * Client-measured video link quality, sent periodically (~5s) while a video track is live. The
 * host uses it to walk its encoder quality ladder: sustained loss steps the bitrate/fps down,
 * a clean link slowly steps back up. Values come from `RTCPeerConnection.getStats()`.
 */
export interface VideoStatsMessage {
  type: "video-stats";
  /** Packet loss over the reporting window, percent (0-100). */
  lossPct: number;
  /** Current round-trip time in ms, when the engine reports it. */
  rttMs?: number;
}

/**
 * Give this machine a friendly display name (e.g. "Work laptop" instead of "DESKTOP-4F2K1").
 * The agent persists it in its state dir and uses it everywhere from then on: the welcome
 * message, the dashboard registry, and the connection dialog. An empty name reverts to the
 * OS hostname. The agent confirms with a `machine-name` broadcast to every controller.
 */
export interface RenameMachineMessage {
  type: "rename-machine";
  name: string;
}

export interface PingMessage {
  type: "ping";
  t: number;
}

export type ClientMessage =
  | HelloMessage
  | AuthMessage
  | VisibilityMessage
  | PointerMessage
  | ScrollMessage
  | KeyMessage
  | TypeMessage
  | SetQualityMessage
  | SetViewportMessage
  | RequestFrameMessage
  | SelectDisplayMessage
  | WatchAddMessage
  | WatchRemoveMessage
  | TimerAddMessage
  | TimerRemoveMessage
  | LashSaveMessage
  | LashRemoveMessage
  | MonitorScanMessage
  | MonitorAddMessage
  | MonitorRemoveMessage
  | MonitorAlwaysMessage
  | VideoStatsMessage
  | RenameMachineMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Agent -> Client (host -> controller)
// ---------------------------------------------------------------------------

export interface ScreenInfo {
  /** Logical screen size in points; pointer normals map onto this. */
  width: number;
  height: number;
}

export interface AgentCapabilities {
  mouse: boolean;
  keyboard: boolean;
  /** Capture backend identifier, e.g. "screenshot-desktop". */
  capture: string;
  /** Host can crop to a sub-region (`set-viewport`). False => it always sends the full screen. */
  region?: boolean;
  /** Host can stream a real WebRTC video track (H.264/VP8) instead of JPEG frames. */
  video?: boolean;
  /** Host can auto-detect + monitor running AI-agent sessions. */
  monitor?: boolean;
}

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  agent: {
    version: string;
    /** Node's `process.platform`, e.g. "darwin", "win32", "linux". */
    platform: string;
    hostname: string;
    /** True when the host desktop runs in HDR ("advanced color") — the stream is tone-mapped to
     * SDR and may look washed compared to the real screen. Optional: older agents omit it. */
    hdr?: boolean;
  };
  screen: ScreenInfo;
  capture: {
    fps: number;
    quality: number;
    maxWidth: number;
  };
  capabilities: AgentCapabilities;
  /** All capturable displays and which one is currently active. */
  displays: DisplayInfo[];
  activeDisplay: number;
  /** Active screen-region change watchers. */
  watchers: WatchRegion[];
  /** Pending one-shot timers (reminders / scheduled actions). */
  timers: TimerInfo[];
  /** Saved lashes (reusable automations) stored on this host. */
  lashes: Lash[];
  /** Active session monitors. */
  monitors: MonitorInfo[];
  /** Agent kinds with "always alert" mode enabled (persisted across restarts). */
  alwaysAgents: AgentKind[];
  /** Recent notifications so a freshly connected client has context. */
  notifications: NotificationMessage[];
}

/** The current set of region watchers (sent when the list changes). */
export interface WatchersMessage {
  type: "watchers";
  regions: WatchRegion[];
}

/** A pending timer, surfaced so controllers can show a live countdown. */
export interface TimerInfo {
  id: string;
  label: string;
  /** Host-epoch ms when it fires; the client derives the remaining time. */
  fireAtMs: number;
  /** Whether an auto-action (click/key/text) runs when it fires. */
  hasAction: boolean;
}

/** The current set of pending timers (sent when the list changes). */
export interface TimersMessage {
  type: "timers";
  timers: TimerInfo[];
}

/** The host's full LashStash (sent when the list changes). */
export interface LashesMessage {
  type: "lashes";
  lashes: Lash[];
}

/** Live AI-agent sessions the host discovered (reply to `monitor-scan`). */
export interface MonitorSessionsMessage {
  type: "monitor-sessions";
  sessions: MonitorSessionInfo[];
}

/** The current set of active session monitors (sent when the list or a state changes). */
export interface MonitorsMessage {
  type: "monitors";
  monitors: MonitorInfo[];
}

/** The agent kinds with "always alert" mode on (sent when a toggle changes). */
export interface MonitorAlwaysAgentsMessage {
  type: "monitor-always-agents";
  agents: AgentKind[];
}

/** Sent when the logical screen size changes (resolution / display switch). */
export interface ScreenMetaMessage {
  type: "screen-meta";
  screen: ScreenInfo;
  /** Present when the change was a display switch. */
  activeDisplay?: number;
}

/**
 * The desktop sub-region the host is currently cropping to, normalized [0,1] of the active
 * display. Lets the controller map each cropped frame back onto the full desktop. Full screen
 * is `{ x: 0, y: 0, w: 1, h: 1 }`. Sent whenever the active viewport changes (see
 * `SetViewportMessage`) and once on `welcome`.
 */
export interface ScreenRegionMessage {
  type: "screen-region";
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * False/absent = the REQUESTED region, echoed the instant the host applies a viewport (lets the
   * controller update the minimap + target immediately). True = that region is now LIVE — the host's
   * re-cropped ffmpeg has produced its FIRST frame, so the controller can switch the displayed frame
   * onto the new rectangle without guessing how long the re-crop took (it's variable: avfoundation
   * re-init alone can exceed half a second). See ScreenView's region bridge.
   */
  active?: boolean;
}

/**
 * Host requires a PIN. Sent instead of `welcome` after a valid `hello` when a PIN is set.
 * The controller answers with an `auth` message. `attemptsLeft` lets the UI warn before
 * the host closes the socket.
 */
export interface AuthRequiredMessage {
  type: "auth-required";
  /** Hex salt for the key-stretch. */
  salt: string;
  /** Iteration count for the stretch (sha256 chain). */
  iterations: number;
  /** Hex nonce that binds this response (prevents replay). */
  nonce: string;
  attemptsLeft: number;
}

/**
 * This session has been taken over by a newer controller connection (single-session rule:
 * the most recent device to pass token + PIN wins). The client must treat this as a terminal
 * close — show a takeover notice and do NOT auto-reconnect, or the two devices would kick
 * each other in a loop.
 */
export interface SupersededMessage {
  type: "superseded";
}

export type NotificationLevel = "info" | "success" | "warning" | "error";

/** Generic event delivered to controllers; the AI-completion use case rides this. */
export interface NotificationMessage {
  type: "notification";
  id: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  /** Free-form origin, e.g. "webhook", "file-watcher:build.log", "vscode". */
  source: string;
  /** Epoch milliseconds. */
  t: number;
}

/** The machine's (possibly just-renamed) display name — broadcast after a `rename-machine`. */
export interface MachineNameMessage {
  type: "machine-name";
  name: string;
}

export interface PongMessage {
  type: "pong";
  t: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  /** Optional machine-readable code, e.g. "input-unavailable". */
  code?: string;
  /** For rate-limit/lockout errors (`code: "pin-locked"`): when the client may retry, in ms. */
  retryAfterMs?: number;
}

export type ServerMessage =
  | WelcomeMessage
  | AuthRequiredMessage
  | ScreenMetaMessage
  | ScreenRegionMessage
  | SupersededMessage
  | WatchersMessage
  | TimersMessage
  | LashesMessage
  | MonitorSessionsMessage
  | MonitorsMessage
  | MonitorAlwaysAgentsMessage
  | NotificationMessage
  | MachineNameMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Type guards (handy on both ends).
// ---------------------------------------------------------------------------

export function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
