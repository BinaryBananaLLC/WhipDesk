import type { ClientMessage } from "@whipdesk/protocol";
import { ControllerCore, type ControllerEvents } from "./core";
import { cacheToken, edgePostKeepalive } from "./cloudApi";
import { signInUrl } from "./site";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  /** Web Push (VAPID) public key — enables background push when set. */
  vapidKey?: string;
  /** WhipDesk edge (Cloudflare Worker) — WebRTC signaling + ICE minting. */
  edgeUrl?: string;
  /** Override the ICE-servers endpoint; defaults to `${edgeUrl}/v1/ice`. */
  iceUrl?: string;
}

const DEFAULT_EDGE_URL = "https://edge.whipdesk.com";
const EDGE_WS_PROTOCOL = "whipdesk.v1";

// HTTPS signaling fallback: on lossy mobile links (mountains-grade 3G) carrier middleboxes kill
// the WS UPGRADE while plain fetch() still works (HTTP/3, per-request retries). If the signaling
// socket can't open within this window, the SAME handshake continues over POST /v1/signal + a
// polled GET — slow but alive, which is the whole "work from anywhere" promise.
const WS_SIGNAL_TIMEOUT_MS = 4_000;
const HTTP_SIGNAL_POLL_MS = 1_500;
const HTTP_SIGNAL_TTL_MS = 2 * 60_000; // matches the hub's pending-session TTL

// STUN fallback used only if fetchIceServers fails: Cloudflare's anycast STUN first, Google's free
// servers as a last resort. The backend normally supplies the full STUN+TURN list.
const STUN = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Read the selected ICE route from getStats: TURN (relay), STUN (srflx), or LAN (host). */
async function detectTransport(pc: RTCPeerConnection): Promise<"TURN" | "STUN" | "LAN" | null> {
  try {
    const stats = await pc.getStats();
    let pairId = "";
    let localId = "";
    stats.forEach((r: any) => {
      if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    stats.forEach((r: any) => {
      if (r.type === "candidate-pair" && !localId && (r.id === pairId || (r.nominated && r.state === "succeeded"))) {
        localId = r.localCandidateId;
      }
    });
    let type = "";
    stats.forEach((r: any) => {
      if (r.id === localId && r.type === "local-candidate") type = r.candidateType;
    });
    if (type === "relay") return "TURN";
    if (type === "srflx" || type === "prflx") return "STUN";
    if (type === "host") return "LAN"; // host candidate = same-network peer-to-peer
  } catch {
    /* stats unavailable */
  }
  return null;
}

/**
 * Remote transport: a WebRTC DataChannel to the agent, brokered by the WhipDesk edge hub — a
 * short-lived WebSocket to the user's own Durable Object relays the SDP offer/answer + trickled
 * ICE candidates to the agent's always-open hub socket. Mirrors `Connection`'s surface
 * (on/send/submitPin/setVisible/connect/close) by wrapping the same `ControllerCore`, so the
 * rest of the app doesn't care which transport is active.
 *
 * The data path is pure P2P + DTLS-encrypted; the edge only carries the handshake.
 */
export class RemoteConnection {
  private readonly core: ControllerCore;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mainXcv: RTCRtpTransceiver | null = null;
  private overviewXcv: RTCRtpTransceiver | null = null;
  // The signaling socket for the CURRENT attempt (closed once the P2P link is up or torn down).
  private signalWs: WebSocket | null = null;
  // Cancels the CURRENT attempt's signaling machinery: the WS-open deadline and, when the HTTP
  // fallback is active, its poll loop (plus a best-effort `end` so the hub/agent clean up now).
  private cancelSignal: (() => void) | null = null;
  private appliedAnswer = false;
  private closed = false;
  private reconnectTimer = 0;
  // getStats-driven link quality (fps + rtt) for the connection dialog.
  private statsTimer = 0;
  // Time-on-WhipDesk accounting: connected seconds banked to the edge (POST /v1/stats) ONCE per
  // session (teardown/disconnect/pagehide) — the Stats page turns the total into "You enjoyed
  // WhipDesk for X hrs". Never flush this on a timer: a per-minute flush is one row write per
  // user per minute, which at scale is millions of writes a day for a vanity counter.
  private flushConnectedTime: (() => void) | null = null;

  constructor(
    private readonly deviceId: string,
    token: string,
    private readonly config: FirebaseWebConfig,
    private readonly opts: { forceRelay?: boolean } = {},
  ) {
    this.core = new ControllerCore(token);
    this.core.setSender((text) => {
      if (this.dc && this.dc.readyState === "open") {
        try {
          this.dc.send(text);
        } catch {
          /* best-effort */
        }
      }
    });
    // A closed/backgrounded tab skips teardown — bank the session here instead (best-effort: the
    // write may not finish during unload; an undercounted session beats a per-minute write bill).
    window.addEventListener("pagehide", () => this.flushConnectedTime?.());
  }

  on<K extends keyof ControllerEvents>(event: K, handler: (value: ControllerEvents[K]) => void): void {
    this.core.on(event, handler);
  }
  send(message: ClientMessage): void {
    this.core.send(message);
  }
  submitPin(pin: string): void {
    this.core.submitPin(pin);
  }
  setVisible(visible: boolean): void {
    this.core.setVisible(visible);
  }

  connect(): void {
    this.closed = false;
    this.start();
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.teardown();
  }

  isHealthy(): boolean {
    return !this.closed && this.pc?.connectionState === "connected" && this.dc?.readyState === "open";
  }

  /**
   * Foreground resume (see ControllerTransport). Mobile browsers freeze/kill a backgrounded tab's
   * WebRTC session — sometimes with no connectionstatechange to trigger the passive reconnect. On
   * return, if the link is down, cancel the (possibly frozen) backoff and rebuild a fresh session
   * right away instead of leaving the user staring at a dead last frame.
   */
  wake(): void {
    if (this.closed || this.isHealthy()) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.teardown();
    this.start();
  }

  /** Open a session; on any failure, retry automatically so the user never refreshes. */
  private start(): void {
    void this.open().catch((error) => {
      this.core.emit("error", `Remote connect failed: ${(error as Error).message}`);
      this.core.emit("status", "disconnected");
      this.scheduleReconnect();
    });
  }

  /** Tear down the current peer connection + signaling socket without ending reconnects. */
  private teardown(): void {
    window.clearInterval(this.statsTimer);
    this.statsTimer = 0;
    this.flushConnectedTime?.(); // bank the session before the pc closes
    this.flushConnectedTime = null;
    this.cancelSignal?.();
    this.cancelSignal = null;
    if (this.signalWs) {
      const ws = this.signalWs;
      this.signalWs = null;
      ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }
    this.appliedAnswer = false;
    this.core.emit("videoTrack", null);
    this.core.emit("overviewTrack", null);
    if (this.dc) {
      this.dc.onopen = this.dc.onclose = this.dc.onmessage = null;
      try {
        this.dc.close();
      } catch {
        /* ignore */
      }
      this.dc = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.ontrack = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.mainXcv = null;
    this.overviewXcv = null;
  }

  // The peer can drop without a page refresh (sleep, network change, agent restart). Rebuild a
  // fresh session after a short delay so control resumes on its own.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (this.closed) return;
      this.teardown();
      this.start();
    }, 2000);
  }

  private async open(): Promise<void> {
    this.core.emit("status", "connecting");

    // Firebase is loaded only for remote mode, so the LAN bundle stays lean.
    const { initializeApp, getApps } = await import("firebase/app");
    const { getAuth } = await import("firebase/auth");

    // Use the DEFAULT app + the user's EXISTING signed-in session (no anonymous auth). The
    // dashboard at whipdesk.com signed the real user in; this same-origin page shares that session.
    const app = getApps()[0] ?? initializeApp(this.config);
    const auth = getAuth(app);
    await new Promise<void>((resolve) => {
      if (auth.currentUser) return resolve();
      const unsub = auth.onAuthStateChanged(() => {
        unsub();
        resolve();
      });
    });
    if (!auth.currentUser) {
      window.location.assign(signInUrl(`/app/${window.location.hash}`));
      return;
    }

    const edgeUrl = (this.config.edgeUrl ?? DEFAULT_EDGE_URL).replace(/\/$/, "");

    // ONE attempt with the full STUN+TURN list. ICE prefers host > srflx > relay, so a same-LAN or
    // STUN pair wins on its own and TURN is used only as a genuine last resort — no probe, no
    // teardown/rebuild (that was the main cause of the minute-long connects over TURN).
    const iceServers = await this.fetchIceServers(auth.currentUser);
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this.opts.forceRelay ? "relay" : "all" });
    this.pc = pc;
    const dc = pc.createDataChannel("whipdesk");
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    this.wireDataChannel(dc);

    // Ask to RECEIVE two desktop H.264 m-lines: [0] the main track (full desktop, or the host's sharp
    // crop when zoomed) and [1] a low-res full-desktop overview that flows only while the main is
    // cropped. The agent answers each sendonly; ontrack routes them apart by transceiver.
    try {
      this.mainXcv = pc.addTransceiver("video", { direction: "recvonly" });
      this.overviewXcv = pc.addTransceiver("video", { direction: "recvonly" });
    } catch {
      /* older engines: video may be unavailable */
    }
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (this.overviewXcv && ev.transceiver === this.overviewXcv) this.core.emit("overviewTrack", stream);
      else this.core.emit("videoTrack", stream);
    };

    let transportReported = false;
    const reportTransport = async () => {
      if (transportReported) return;
      const kind = await detectTransport(pc);
      if (!kind) return;
      transportReported = true;
      this.core.emit("transport", kind);
      // One write per connection. The edge hub bumps TWO counters from this single event — the
      // all-time map AND the current UTC month bucket (the month key is computed server-side, so
      // reader and writer can never disagree on which month a connection lands in).
      const key = kind === "TURN" ? "turn" : kind === "STUN" ? "stun" : "lan";
      try {
        const t = await auth.currentUser!.getIdToken();
        cacheToken(t);
        void fetch(`${edgeUrl}/v1/stats`, {
          method: "POST",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
          body: JSON.stringify({ v: 1, transport: key }),
        }).catch(() => {});
      } catch {
        /* stats are best-effort */
      }
    };

    // Time-on-WhipDesk: bank connected seconds to the edge, ONE write per session end
    // (teardown/disconnect/pagehide). Built fully synchronously from the cached ID token —
    // an async token mint never completes inside pagehide — and sent with keepalive so the
    // request survives the page going away. A hard-killed tab loses that session's time —
    // accepted: this is a feel-good counter, not billing, and periodic flushing costs real money.
    let connectedSince = 0;
    const flushTime = () => {
      if (!connectedSince) return;
      const secs = Math.round((Date.now() - connectedSince) / 1000);
      connectedSince = 0;
      if (secs < 1) return;
      edgePostKeepalive(this.config, "/v1/stats", { v: 1, secs });
    };
    this.flushConnectedTime = flushTime;

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        this.core.emit("status", "connected");
        if (!connectedSince) connectedSince = Date.now();
        void reportTransport();
        this.startStatsPoll(pc);
      } else if (s === "failed" || s === "disconnected" || s === "closed") {
        flushTime();
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    // Trickle ICE over the edge hub: publish the offer immediately (no gather wait) and stream
    // candidates BOTH ways as WS messages, so the connection forms as candidates arrive. The hub
    // relays with ordered exactly-once delivery — no candidate keys, no de-dupe. When the WS can't
    // open (hostile network), the SAME handshake continues over HTTPS: POST /v1/signal for the
    // client->hub direction, a polled GET for the buffered hub->client replies.
    let sid = crypto.randomUUID();
    const queuedCands: RTCIceCandidateInit[] = [];
    let connectSent = false;
    let signalMode: "ws" | "http" = "ws";
    let signalDead = false; // set by teardown — every async loop below checks it

    const sendSignal = (msg: Record<string, unknown>) => {
      if (this.signalWs?.readyState === WebSocket.OPEN) {
        try {
          this.signalWs.send(JSON.stringify({ v: 1, ...msg }));
          return true;
        } catch {
          /* fall through */
        }
      }
      return false;
    };

    // One hub->client signaling message — shared verbatim by the WS and HTTP channels.
    // Returns true on a terminal end/error for this sid, which stops the HTTP poll loop.
    const handleSignal = (msg: {
      v?: number;
      t?: string;
      sid?: string;
      sdp?: string;
      cand?: RTCIceCandidateInit;
      code?: string;
    }): boolean => {
      if (msg.v !== 1) return false;
      if (msg.t === "answer" && msg.sid === sid && msg.sdp && !this.appliedAnswer) {
        this.appliedAnswer = true;
        void pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.t === "cand" && msg.sid === sid && msg.cand && this.appliedAnswer) {
        try {
          void pc.addIceCandidate(msg.cand);
        } catch {
          /* late/invalid candidate */
        }
      } else if ((msg.t === "error" || msg.t === "end") && (!msg.sid || msg.sid === sid)) {
        // device-offline / timeout / agent bailed — surface it and retry like any drop.
        if (!this.appliedAnswer) {
          this.core.emit("error", msg.t === "error" ? `Remote connect failed: ${msg.code ?? "error"}` : "Remote connect failed");
          this.core.emit("status", "disconnected");
          this.scheduleReconnect();
        }
        return true;
      }
      return false;
    };

    const signalUrl = `${edgeUrl}/v1/signal`;

    // ---- HTTP fallback channel ----
    const postSignal = async (msg: Record<string, unknown>): Promise<Response> => {
      const t = await auth.currentUser!.getIdToken();
      cacheToken(t);
      return fetch(signalUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, ...msg }),
      });
    };
    // Candidates go out one at a time in order (a promise chain), like the WS framing they replace.
    let candChain: Promise<unknown> = Promise.resolve();
    const postCand = (cand: RTCIceCandidateInit) => {
      candChain = candChain.then(
        () => (signalDead ? undefined : postSignal({ t: "cand", sid, cand }).catch(() => undefined)),
        () => undefined,
      );
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const cand = ev.candidate.toJSON();
      if (!connectSent) {
        queuedCands.push(cand);
      } else if (signalMode === "http") {
        postCand(cand);
      } else if (!sendSignal({ t: "cand", sid, cand })) {
        queuedCands.push(cand);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const runHttpSignaling = async () => {
      const startedAt = Date.now();
      try {
        const res = await postSignal({ t: "connect", sid, device: this.deviceId, sdp: pc.localDescription?.sdp ?? "" });
        if (signalDead || this.closed) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
      } catch (error) {
        // Even resilient HTTPS failed (or the device is offline) — retry the whole attempt.
        if (signalDead || this.closed) return;
        this.core.emit("error", `Remote connect failed: ${(error as Error).message}`);
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
        return;
      }
      connectSent = true;
      while (queuedCands.length > 0) postCand(queuedCands.shift()!);

      // Poll for the agent's answer/candidates until the P2P link is up or the session TTL runs
      // out (the hub sweeps the session then anyway). Transient poll failures just poll again —
      // surviving a lossy link is this channel's entire purpose.
      let cursor = 0;
      while (!signalDead && !this.closed) {
        if (pc.connectionState === "connected") return; // media is up — signaling is done
        if (Date.now() - startedAt > HTTP_SIGNAL_TTL_MS) break;
        await new Promise((r) => setTimeout(r, HTTP_SIGNAL_POLL_MS + Math.random() * 500));
        if (signalDead || this.closed) return;
        try {
          const t = await auth.currentUser!.getIdToken();
          const res = await fetch(`${signalUrl}?sid=${encodeURIComponent(sid)}&since=${cursor}`, {
            headers: { authorization: `Bearer ${t}` },
          });
          if (res.status === 404) break; // session expired/ended server-side
          if (!res.ok) continue;
          const body = (await res.json()) as { events?: unknown[]; next?: number };
          if (signalDead || this.closed) return;
          cursor = Number(body.next) || cursor;
          for (const ev of body.events ?? []) {
            if (handleSignal(ev as Parameters<typeof handleSignal>[0])) return;
          }
        } catch {
          /* transient — next poll retries */
        }
      }
      // TTL/404 without an answer: same outcome as the WS-path timeout error.
      if (!signalDead && !this.closed && !this.appliedAnswer) {
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    const startHttpSignaling = () => {
      if (signalDead || this.closed || this.appliedAnswer || signalMode === "http") return;
      signalMode = "http";
      // Drop the (still-dialing or dead) WS quietly — its handlers must not double-drive retries.
      if (this.signalWs) {
        const w = this.signalWs;
        this.signalWs = null;
        w.onopen = w.onclose = w.onmessage = w.onerror = null;
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      // If the offer already went out over the WS, the agent may hold a half-open session for that
      // sid (the hub ends it when the dead socket closes). A fresh sid makes this a clean new
      // handshake instead of a duplicate offer.
      if (connectSent) {
        sid = crypto.randomUUID();
        connectSent = false;
      }
      void runHttpSignaling();
    };

    // ---- WS channel (the normal path) ----
    const wsUrl = `${edgeUrl.replace(/^http/, "ws")}/v1/connect?role=client`;
    const token = await auth.currentUser.getIdToken();
    cacheToken(token);
    // Browsers can't set WS headers — the ID token rides the subprotocol list.
    const ws = new WebSocket(wsUrl, [EDGE_WS_PROTOCOL, `auth.${token}`]);
    this.signalWs = ws;
    // A WS that can't open quickly on a link where HTTPS works is the mountains failure mode.
    const wsDeadline = window.setTimeout(startHttpSignaling, WS_SIGNAL_TIMEOUT_MS);
    this.cancelSignal = () => {
      signalDead = true;
      window.clearTimeout(wsDeadline);
      // The WS path cleans hub/agent state via the socket close; give the HTTP path the same
      // courtesy so the session dies now, not at the 2-minute TTL. Best-effort (may race unload).
      if (signalMode === "http" && connectSent) {
        const endSid = sid;
        void auth
          .currentUser!.getIdToken()
          .then((t) =>
            fetch(signalUrl, {
              method: "POST",
              keepalive: true,
              headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
              body: JSON.stringify({ v: 1, t: "end", sid: endSid }),
            }),
          )
          .catch(() => {});
      }
    };
    // Kept open for the life of the P2P session: a dying tab closes it, which tells the hub (and
    // the agent) to drop the signaling state — no orphaned handshakes to sweep up later.
    ws.onopen = () => {
      if (this.closed || this.signalWs !== ws) return;
      window.clearTimeout(wsDeadline);
      sendSignal({ t: "connect", sid, device: this.deviceId, sdp: pc.localDescription?.sdp ?? "" });
      connectSent = true;
      while (queuedCands.length > 0) {
        const cand = queuedCands.shift()!;
        if (!sendSignal({ t: "cand", sid, cand })) {
          queuedCands.unshift(cand);
          break;
        }
      }
    };
    ws.onmessage = (ev) => {
      if (this.closed || this.signalWs !== ws) return;
      let msg: Parameters<typeof handleSignal>[0];
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      handleSignal(msg);
    };
    ws.onclose = () => {
      if (this.closed || this.signalWs !== ws) return;
      this.signalWs = null;
      window.clearTimeout(wsDeadline);
      // Socket died mid-handshake (edge hiccup, token expiry, hostile middlebox): continue this
      // attempt over HTTPS. After the P2P link is up the peer connection owns the session and a
      // signaling drop is irrelevant.
      if (!this.appliedAnswer) startHttpSignaling();
    };
  }

  /** Poll getStats once a second for fps + round-trip, surfaced in the connection dialog. */
  private startStatsPoll(pc: RTCPeerConnection): void {
    window.clearInterval(this.statsTimer);
    this.lossBase = null;
    this.statsPolls = 0;
    this.statsTimer = window.setInterval(() => void this.pollStats(pc), 1000);
  }

  // Cumulative inbound video counters at the start of the current loss-reporting window; every
  // ~5s the delta becomes a `video-stats` report the host's quality ladder adapts to.
  private lossBase: { lost: number; received: number } | null = null;
  private statsPolls = 0;

  private async pollStats(pc: RTCPeerConnection): Promise<void> {
    let rtt: number | null = null;
    let fps = 0;
    let lost = 0;
    let received = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((r: any) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          fps = Math.max(fps, Number(r.framesPerSecond ?? 0));
          lost += Number(r.packetsLost ?? 0);
          received += Number(r.packetsReceived ?? 0);
        } else if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number") {
          rtt = r.currentRoundTripTime as number;
        }
      });
    } catch {
      return; // stats unavailable on this engine
    }
    this.core.emit("netStats", { fps: Math.round(fps), rtt: rtt != null ? Math.round(rtt * 1000) : null });

    // Loss report for the host's adaptive quality ladder, once per ~5s window.
    this.statsPolls += 1;
    if (!this.lossBase) {
      this.lossBase = { lost, received };
    } else if (this.statsPolls % 5 === 0) {
      const dLost = Math.max(0, lost - this.lossBase.lost);
      const dReceived = Math.max(0, received - this.lossBase.received);
      this.lossBase = { lost, received };
      const total = dLost + dReceived;
      if (total > 0) {
        const lossPct = (dLost / total) * 100;
        this.core.send({ type: "video-stats", lossPct, rttMs: rtt != null ? Math.round(rtt * 1000) : undefined });
      }
    }
  }

  private wireDataChannel(dc: RTCDataChannel): void {
    dc.onopen = () => this.core.sendHello();
    dc.onclose = () => {
      this.core.emit("status", "disconnected");
      this.scheduleReconnect();
    };
    dc.onmessage = (event) => {
      // Control/input only — the screen now rides the H.264 video tracks, never this channel.
      if (typeof event.data === "string") this.core.handleText(event.data);
    };
  }

  /** Fetch STUN-first + ephemeral TURN servers from the edge (auth-gated, load-balanced).
   * Cached in sessionStorage so reconnects skip the round trip. Falls back to our own STUN. */
  private async fetchIceServers(user: { getIdToken(): Promise<string> }): Promise<RTCIceServer[]> {
    const fallback: RTCIceServer[] = [...STUN];
    try {
      const cached = sessionStorage.getItem("wd-ice");
      if (cached) {
        const { servers, exp } = JSON.parse(cached) as { servers: RTCIceServer[]; exp: number };
        if (Array.isArray(servers) && servers.length && exp > Date.now()) return servers;
      }
    } catch {
      /* ignore */
    }
    // Behind CGNAT (mobile in the mountains) a relay is MANDATORY — STUN-only can't punch through,
    // so degrading to the public-STUN fallback there means "never connects". A single flaky request
    // must not doom the attempt: retry a few times with backoff before giving up on TURN. The fetch
    // itself has no timeout, so a merely-slow link waits rather than falling back prematurely.
    const url = this.config.iceUrl || `${(this.config.edgeUrl ?? DEFAULT_EDGE_URL).replace(/\/$/, "")}/v1/ice`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const token = await user.getIdToken();
        cacheToken(token);
        const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (res.ok) {
          const body = (await res.json()) as { iceServers?: RTCIceServer[] };
          if (Array.isArray(body.iceServers) && body.iceServers.length) {
            try {
              sessionStorage.setItem(
                "wd-ice",
                JSON.stringify({ servers: body.iceServers, exp: Date.now() + 8 * 60_000 }),
              );
            } catch {
              /* ignore */
            }
            return body.iceServers;
          }
        }
      } catch {
        /* transient network error — retry below before falling back to STUN-only */
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    return fallback;
  }
}
