import type { ClientMessage } from "@whipdesk/protocol";
import { ControllerCore, type ControllerEvents } from "./core";
import { signInUrl } from "./site";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  /** Web Push (VAPID) public key — enables FCM background push when set (Firebase console). */
  vapidKey?: string;
  /** WhipDesk edge (Cloudflare Worker) — WebRTC signaling + ICE minting. */
  edgeUrl?: string;
  /** Override the ICE-servers endpoint; defaults to `${edgeUrl}/v1/ice`. */
  iceUrl?: string;
}

const DEFAULT_EDGE_URL = "https://edge.whipdesk.com";
const EDGE_WS_PROTOCOL = "whipdesk.v1";

// Public STUN fallback (Google's free servers). The backend normally supplies the full STUN+TURN
// list via fetchIceServers; this is used only if that fetch fails.
const STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

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
  private appliedAnswer = false;
  private closed = false;
  private reconnectTimer = 0;
  // getStats-driven link quality (fps + rtt) for the connection dialog.
  private statsTimer = 0;
  // Time-on-WhipDesk accounting: connected seconds flushed every minute (and on teardown) into
  // users/{uid}.stats.secs — the Stats page turns the total into "You enjoyed WhipDesk for X hrs".
  private timeTimer = 0;
  private flushConnectedTime: (() => void) | null = null;

  constructor(
    private readonly deviceId: string,
    token: string,
    private readonly config: FirebaseWebConfig,
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
    // A closed/backgrounded tab skips teardown — bank the current minute here too (best-effort:
    // the write may not finish during unload, costing at most ~60s of counted time).
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
    window.clearInterval(this.timeTimer);
    this.timeTimer = 0;
    this.flushConnectedTime?.(); // bank the tail of the session before the pc closes
    this.flushConnectedTime = null;
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
    const uid = auth.currentUser.uid;

    // ONE attempt with the full STUN+TURN list. ICE prefers host > srflx > relay, so a same-LAN or
    // STUN pair wins on its own and TURN is used only as a genuine last resort — no probe, no
    // teardown/rebuild (that was the main cause of the minute-long connects over TURN).
    const iceServers = await this.fetchIceServers(auth.currentUser);
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
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
      // One write per connection. Stats are PERSISTENT user data -> Firestore. We bump TWO counters:
      // the all-time map on the user doc, and a per-month doc (users/{uid}/statsMonthly/{YYYY-MM})
      // so the dashboard can show "all time" vs "this/last month" without scanning history. Month id
      // is UTC, taken straight off the ISO string (no hand-rolled month math — getUTCMonth() is
      // 0-based and off-by-one bugs love it), and MUST match the reader (WWW lib/devices.ts monthId).
      const key = kind === "TURN" ? "turn" : kind === "STUN" ? "stun" : "lan";
      const ym = new Date().toISOString().slice(0, 7);
      try {
        const { getFirestore, doc, setDoc, increment } = await import("firebase/firestore");
        const fs = getFirestore(app);
        void setDoc(doc(fs, "users", uid), { stats: { [key]: increment(1) } }, { merge: true }).catch(() => {});
        void setDoc(doc(fs, "users", uid, "statsMonthly", ym), { [key]: increment(1) }, { merge: true }).catch(
          () => {},
        );
      } catch {
        /* stats are best-effort */
      }
    };

    // Time-on-WhipDesk: bank connected seconds into users/{uid}.stats.secs. Flushed once a minute
    // and on teardown/disconnect, so a killed tab loses at most the last minute. All-time only —
    // the statsMonthly rules allow just the lan/stun/turn counters.
    let connectedSince = 0;
    const flushTime = (final = false) => {
      if (!connectedSince) return;
      const secs = Math.round((Date.now() - connectedSince) / 1000);
      connectedSince = !final && pc.connectionState === "connected" ? Date.now() : 0;
      if (secs < 1) return;
      void (async () => {
        const { getFirestore, doc, setDoc, increment } = await import("firebase/firestore");
        await setDoc(doc(getFirestore(app), "users", uid), { stats: { secs: increment(secs) } }, { merge: true });
      })().catch(() => {
        /* best-effort */
      });
    };
    this.flushConnectedTime = () => flushTime(true);
    window.clearInterval(this.timeTimer);
    this.timeTimer = window.setInterval(flushTime, 60_000);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        this.core.emit("status", "connected");
        if (!connectedSince) connectedSince = Date.now();
        void reportTransport();
        this.startStatsPoll(pc);
      } else if (s === "failed" || s === "disconnected" || s === "closed") {
        flushTime(true);
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    // Trickle ICE over the edge hub: publish the offer immediately (no gather wait) and stream
    // candidates BOTH ways as WS messages, so the connection forms as candidates arrive. The hub
    // relays with ordered exactly-once delivery — no candidate keys, no de-dupe.
    const sid = crypto.randomUUID();
    const queuedCands: RTCIceCandidateInit[] = [];
    let connectSent = false;
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
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const cand = ev.candidate.toJSON();
      if (!connectSent || !sendSignal({ t: "cand", sid, cand })) queuedCands.push(cand);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const edgeUrl = (this.config.edgeUrl ?? DEFAULT_EDGE_URL).replace(/\/$/, "");
    const wsUrl = `${edgeUrl.replace(/^http/, "ws")}/v1/connect?role=client`;
    const token = await auth.currentUser.getIdToken();
    // Browsers can't set WS headers — the ID token rides the subprotocol list.
    const ws = new WebSocket(wsUrl, [EDGE_WS_PROTOCOL, `auth.${token}`]);
    this.signalWs = ws;
    // Kept open for the life of the P2P session: a dying tab closes it, which tells the hub (and
    // the agent) to drop the signaling state — the replacement for RTDB's onDisconnect cleanup.
    ws.onopen = () => {
      if (this.closed || this.signalWs !== ws) return;
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
      let msg: { v?: number; t?: string; sid?: string; sdp?: string; cand?: RTCIceCandidateInit; code?: string };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.v !== 1) return;
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
      }
    };
    ws.onclose = () => {
      if (this.closed || this.signalWs !== ws) return;
      this.signalWs = null;
      // Socket died mid-handshake (edge hiccup, token expiry): retry. After the P2P link is up
      // the peer connection owns the session and a signaling drop is irrelevant.
      if (!this.appliedAnswer) {
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
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
    try {
      const url = this.config.iceUrl || `${(this.config.edgeUrl ?? DEFAULT_EDGE_URL).replace(/\/$/, "")}/v1/ice`;
      const token = await user.getIdToken();
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
      /* backend hiccup -> own STUN keeps direct/STUN working */
    }
    return fallback;
  }
}
