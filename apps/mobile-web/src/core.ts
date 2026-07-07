import {
  isServerMessage,
  type AgentKind,
  type ClientMessage,
  type MonitorInfo,
  type MonitorSessionInfo,
  type NotificationMessage,
  type ScreenInfo,
  type ServerMessage,
  type TimerInfo,
  type WatchRegion,
  type WelcomeMessage,
} from "@whipdesk/protocol";
import { responseFor, stretch } from "./crypto";

// Mirrors PROTOCOL_VERSION in packages/protocol. Kept local so version-mismatch detection works
// even against a protocol build that predates the constant. (The tiny isServerMessage guard IS
// imported from the package — Vite inlines it.)
export const PROTOCOL_VERSION = 1;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface PinRequest {
  attemptsLeft: number;
  retry: boolean;
}

export interface ControllerEvents {
  status: ConnectionStatus;
  welcome: WelcomeMessage;
  screenMeta: { screen: ScreenInfo; activeDisplay?: number };
  screenRegion: { x: number; y: number; w: number; h: number; active?: boolean };
  /** The main H.264 desktop track (full desktop, or the host's sharp crop when zoomed), or null. */
  videoTrack: MediaStream | null;
  /** Low-res full-desktop overview track — carries frames only while the main track is cropped. */
  overviewTrack: MediaStream | null;
  /** How the screen is reaching us: "LAN", "STUN", or "TURN". */
  transport: string;
  /** Live link quality for the connection dialog: rendered frames/sec + round-trip ms. */
  netStats: { fps: number; rtt: number | null };
  notification: NotificationMessage;
  presence: number;
  /** The machine's display name changed (someone renamed it via the connection dialog). */
  machineName: string;
  pinRequired: PinRequest;
  watchers: WatchRegion[];
  timers: TimerInfo[];
  /** Active session monitors (the host's authoritative list). */
  monitors: MonitorInfo[];
  /** Agent kinds with "always alert" mode on (persisted host-side). */
  monitorAlways: AgentKind[];
  /** Live AI-agent sessions discovered by the host (reply to a scan). */
  monitorSessions: MonitorSessionInfo[];
  /**
   * The connected agent speaks a different wire protocol than this (always-fresh) client — i.e. the
   * agent build is out of step. Emitted once per welcome; the UI nudges the user to update the agent.
   * This is the deliberate "no backward-compat" lever: bump PROTOCOL_VERSION on breaking changes
   * instead of carrying shims.
   */
  versionMismatch: { agentProtocol: number; clientProtocol: number; agentVersion?: string };
  error: string;
}

type Handler<T> = (value: T) => void;

/** Common surface implemented by both the LAN (WebSocket) and remote (WebRTC) transports. */
export interface ControllerTransport {
  on<K extends keyof ControllerEvents>(event: K, handler: Handler<ControllerEvents[K]>): void;
  send(message: ClientMessage): void;
  submitPin(pin: string): void;
  setVisible(visible: boolean): void;
  connect(): void;
  close(): void;
  /** True when the session is live and usable right now (peer connected + data channel open). */
  isHealthy(): boolean;
  /**
   * Foreground resume. A backgrounded mobile tab often has its WebRTC session frozen or torn down
   * without any state-change event firing, so on return we can't trust the passive reconnect
   * backoff. Call this when the page becomes visible again: if the link is down it rebuilds a fresh
   * session immediately; if it's healthy it's a no-op.
   */
  wake(): void;
}

/**
 * Transport-neutral controller logic: the event bus, the server-message switch, and PIN
 * challenge state. A transport (WebRTC for both LAN and remote) owns the peer connection, calls
 * `setSender`, feeds inbound control messages via `handleText`, and surfaces the H.264 screen as
 * `videoTrack`. This mirrors the agent's `transport/session.ts` split.
 */
export class ControllerCore {
  private readonly handlers: { [K in keyof ControllerEvents]: Set<Handler<ControllerEvents[K]>> } = {
    status: new Set(),
    welcome: new Set(),
    screenMeta: new Set(),
    screenRegion: new Set(),
    videoTrack: new Set(),
    overviewTrack: new Set(),
    transport: new Set(),
    notification: new Set(),
    presence: new Set(),
    machineName: new Set(),
    pinRequired: new Set(),
    watchers: new Set(),
    timers: new Set(),
    monitors: new Set(),
    monitorAlways: new Set(),
    monitorSessions: new Set(),
    netStats: new Set(),
    versionMismatch: new Set(),
    error: new Set(),
  };
  private sender: (text: string) => void = () => {};
  private challenge: { salt: string; iterations: number; nonce: string } | null = null;
  private wrongPin = false;
  // In-memory ONLY (never localStorage/sessionStorage), so a page load/refresh always starts null
  // and the user is re-prompted. Replayed solely to avoid re-prompting on transient in-session
  // reconnects (network blip, agent restart). NOT a security bypass: the agent re-validates the PIN
  // (challenge/response) on EVERY connection, and a wrong PIN clears this.
  private rememberedPin: string | null = null;

  constructor(private readonly token: string) {}

  on<K extends keyof ControllerEvents>(event: K, handler: Handler<ControllerEvents[K]>): void {
    this.handlers[event].add(handler);
  }
  emit<K extends keyof ControllerEvents>(event: K, value: ControllerEvents[K]): void {
    for (const handler of this.handlers[event]) handler(value);
  }

  /** The transport supplies how to send a text frame. */
  setSender(fn: (text: string) => void): void {
    this.sender = fn;
  }

  send(message: ClientMessage): void {
    try {
      this.sender(JSON.stringify(message));
    } catch {
      /* best-effort */
    }
  }

  /** Send the `hello` handshake (called by the transport once the channel is open). */
  sendHello(): void {
    this.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: this.token,
      role: "controller",
      client: { userAgent: navigator.userAgent },
    });
  }

  submitPin(pin: string): void {
    this.rememberedPin = pin; // replay on reconnect
    if (!this.challenge) return;
    const { salt, iterations, nonce } = this.challenge;
    const key = stretch(pin, salt, iterations);
    this.send({ type: "auth", response: responseFor(key, nonce) });
  }

  setVisible(visible: boolean): void {
    this.send({ type: "visibility", visible });
  }

  /** Feed an inbound JSON control message. */
  handleText(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isServerMessage(parsed)) return;
    const message: ServerMessage = parsed;
    switch (message.type) {
      case "welcome":
        this.challenge = null;
        if (message.protocol !== PROTOCOL_VERSION) {
          this.emit("versionMismatch", {
            agentProtocol: message.protocol,
            clientProtocol: PROTOCOL_VERSION,
            agentVersion: message.agent?.version,
          });
        }
        this.emit("welcome", message);
        this.emit("timers", message.timers ?? []);
        this.emit("monitors", message.monitors ?? []);
        this.emit("monitorAlways", message.alwaysAgents ?? []);
        break;
      case "auth-required":
        this.challenge = { salt: message.salt, iterations: message.iterations, nonce: message.nonce };
        // First connect (fresh page load/refresh) ALWAYS prompts — rememberedPin is in-memory and
        // starts null. Only a transient in-session reconnect (where we already learned the PIN)
        // re-auths silently so the user isn't re-prompted on every network blip.
        if (this.rememberedPin && !this.wrongPin) {
          this.submitPin(this.rememberedPin);
        } else {
          this.emit("pinRequired", { attemptsLeft: message.attemptsLeft, retry: this.wrongPin });
        }
        this.wrongPin = false;
        break;
      case "screen-meta":
        this.emit("screenMeta", { screen: message.screen, activeDisplay: message.activeDisplay });
        break;
      case "screen-region":
        this.emit("screenRegion", { x: message.x, y: message.y, w: message.w, h: message.h, active: message.active });
        break;
      case "notification":
        this.emit("notification", message);
        break;
      case "presence":
        this.emit("presence", message.watchers);
        break;
      case "machine-name":
        this.emit("machineName", message.name);
        break;
      case "watchers":
        this.emit("watchers", message.regions);
        break;
      case "timers":
        this.emit("timers", message.timers);
        break;
      case "monitors":
        this.emit("monitors", message.monitors);
        break;
      case "monitor-always-agents":
        this.emit("monitorAlways", message.agents);
        break;
      case "monitor-sessions":
        this.emit("monitorSessions", message.sessions);
        break;
      case "error":
        if (message.code === "pin") {
          this.wrongPin = true;
          this.rememberedPin = null; // a wrong saved PIN must prompt, not loop
        } else this.emit("error", message.message);
        break;
      case "pong":
        break;
    }
  }
}
