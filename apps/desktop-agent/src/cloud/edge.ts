import WebSocket from "ws";
import { log } from "../logger";
import type { AgentAuth } from "./auth";
import type { IceServer } from "./ice";

/**
 * The agent's single connection to the WhipDesk edge (Cloudflare Worker + the user's own
 * Durable Object "hub"): one WebSocket that carries device presence AND WebRTC signaling.
 *
 * Presence is CONNECTION-TRUTH: while this socket is up the dashboard shows the machine online;
 * when it drops the hub marks it offline. There is no heartbeat write anywhere — the only
 * keepalive is a native WebSocket protocol ping (answered at the Cloudflare edge without even
 * waking the hub), which also keeps NAT/middlebox mappings alive.
 *
 * Auth: the Firebase ID token rides the subprotocol list (`whipdesk.v1, auth.<token>`) —
 * verified once per connection by the Worker. A planned reconnect every ~24 h (jittered)
 * re-presents a fresh token so a revoked account drops off within a day; auth.getIdToken()
 * self-refreshes, so a valid token is always at hand.
 */

export interface EdgeLan {
  ip: string;
  port: number;
  token: string;
}

export interface EdgeDevice {
  id: string;
  name: string;
  platform: string;
  version: string;
  lan: EdgeLan;
}

export interface EdgeClientOptions {
  /** HTTPS base, e.g. https://edge.whipdesk.com (wss derived from it). */
  url: string;
  auth: AgentAuth;
  /** Re-read at each (re)connect so the hello always carries the current LAN endpoint. */
  device: () => EdgeDevice;
}

interface EdgeIncoming {
  v: number;
  t: string;
  sid?: string;
  sdp?: string;
  cand?: unknown;
  rid?: string;
  iceServers?: IceServer[];
  ttlSec?: number;
}

type Handler = (msg: EdgeIncoming) => void;

const WS_PROTOCOL = "whipdesk.v1";
const PING_BASE_MS = 45_000; // + jitter; well under NAT UDP/TCP idle timeouts
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const REAUTH_MS = 24 * 3600_000; // planned reconnect: fresh token once a day (±6h jitter)
const ICE_REPLY_TIMEOUT_MS = 8_000;

export class EdgeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_MIN_MS;
  private handlers = new Map<string, Set<Handler>>();
  private iceWaiters = new Map<string, (msg: EdgeIncoming) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;

  constructor(private readonly options: EdgeClientOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    this.reconnectTimer = null;
    this.reauthTimer = null;
    try {
      this.ws?.close(1000, "shutdown");
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  get uid(): string {
    return this.options.auth.uid;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on(type: "open" | "offer" | "cand" | "end", handler: Handler): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
  }

  send(msg: Record<string, unknown>): boolean {
    if (!this.isConnected()) return false;
    try {
      this.ws?.send(JSON.stringify({ v: 1, ...msg }));
      return true;
    } catch {
      return false;
    }
  }

  /** Re-send the hello (device metadata) on the open socket — e.g. after a machine rename. The
   * hub treats a repeat hello as a registry update and broadcasts the delta to open dashboards.
   * No-op while disconnected: the next reconnect's hello carries the fresh metadata anyway. */
  announce(): void {
    if (!this.isConnected()) return;
    this.send({ t: "hello", device: this.options.device() });
  }

  /** In-band ICE mint (STUN + ephemeral TURN) over the already-open hub socket. */
  requestIce(): Promise<{ iceServers: IceServer[]; ttlSec: number } | null> {
    if (!this.isConnected()) return Promise.resolve(null);
    const rid = Math.random().toString(36).slice(2, 10);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.iceWaiters.delete(rid);
        resolve(null);
      }, ICE_REPLY_TIMEOUT_MS);
      timer.unref?.();
      this.iceWaiters.set(rid, (msg) => {
        clearTimeout(timer);
        this.iceWaiters.delete(rid);
        resolve(
          Array.isArray(msg.iceServers) && msg.iceServers.length > 0
            ? { iceServers: msg.iceServers, ttlSec: Number(msg.ttlSec) || 600 }
            : null,
        );
      });
      if (!this.send({ t: "ice", rid })) {
        clearTimeout(timer);
        this.iceWaiters.delete(rid);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------- wiring

  private wsUrl(deviceId: string): string {
    const base = this.options.url.replace(/\/$/, "").replace(/^http/, "ws");
    return `${base}/v1/connect?role=agent&device=${encodeURIComponent(deviceId)}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let token: string;
    const device = this.options.device();
    try {
      token = await this.options.auth.getIdToken();
    } catch (error) {
      log.warn("edge: token refresh failed, retrying:", (error as Error).message);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(this.wsUrl(device.id), [WS_PROTOCOL, `auth.${token}`], {
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    let pongDeadline: ReturnType<typeof setTimeout> | null = null;
    let pinger: ReturnType<typeof setInterval> | null = null;
    const clearKeepalive = () => {
      if (pinger) clearInterval(pinger);
      if (pongDeadline) clearTimeout(pongDeadline);
      pinger = null;
      pongDeadline = null;
    };

    ws.on("open", () => {
      this.backoffMs = BACKOFF_MIN_MS;
      // Presence + metadata in one message; the hub broadcasts the "online" delta from it.
      this.send({ t: "hello", device });
      if (!this.everConnected) {
        this.everConnected = true;
        log.info(`cloud: connected — "${device.name}" is registered to your account ✓`);
      }
      this.emit("open", { v: 1, t: "open" });

      // Native protocol pings: free at the Cloudflare edge, never wake the hub, keep NAT alive.
      pinger = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.ping();
        } catch {
          return;
        }
        if (!pongDeadline) {
          pongDeadline = setTimeout(() => ws.terminate(), PONG_TIMEOUT_MS);
          pongDeadline.unref?.();
        }
      }, PING_BASE_MS + Math.floor(Math.random() * 10_000));
      pinger.unref?.();
      ws.on("pong", () => {
        if (pongDeadline) clearTimeout(pongDeadline);
        pongDeadline = null;
      });

      // Planned re-auth reconnect (fresh ID token) once a day, jittered so fleets never herd.
      if (this.reauthTimer) clearTimeout(this.reauthTimer);
      this.reauthTimer = setTimeout(() => ws.close(1000, "reauth"), REAUTH_MS + Math.floor(Math.random() * 6 * 3600_000));
      this.reauthTimer.unref?.();
    });

    ws.on("message", (data) => {
      let msg: EdgeIncoming;
      try {
        msg = JSON.parse(String(data)) as EdgeIncoming;
      } catch {
        return;
      }
      if (msg.v !== 1 || typeof msg.t !== "string") return;
      if (msg.t === "ice" && msg.rid && this.iceWaiters.has(msg.rid)) {
        this.iceWaiters.get(msg.rid)?.(msg);
        return;
      }
      this.emit(msg.t, msg);
    });

    ws.on("close", (code, reason) => {
      clearKeepalive();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      if (code === 4000) {
        // Another agent process took over this device id (we were superseded) — stop competing.
        log.warn("edge: another agent instance connected for this machine — standing down.");
        this.stopped = true;
        return;
      }
      log.info(`edge: disconnected (${code}${reason?.length ? ` ${reason}` : ""}) — reconnecting`);
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      if (!this.everConnected) log.warn("edge: connect failed:", (error as Error).message);
      // "close" follows and schedules the reconnect.
    });

    ws.on("unexpected-response", (_req, res) => {
      log.warn(`edge: connect rejected (HTTP ${res.statusCode}) — retrying`);
      ws.terminate();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.floor(Math.random() * this.backoffMs); // full jitter
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), Math.max(250, delay));
    this.reconnectTimer.unref?.();
  }

  private emit(type: string, msg: EdgeIncoming): void {
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        handler(msg);
      } catch (error) {
        log.warn(`edge: ${type} handler failed:`, (error as Error).message);
      }
    }
  }
}
