import type { ClientMessage } from "@whipdesk/protocol";
import { ControllerCore, type ControllerEvents } from "./core";
import { signInUrl } from "./site";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  databaseURL?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  /** Web Push (VAPID) public key — enables FCM background push when set (Firebase console). */
  vapidKey?: string;
  /** Override the ICE-servers endpoint; defaults to the project's Cloud Function URL. */
  iceUrl?: string;
}

// Our own STUN as the only fallback (no public/free STUN). The backend normally supplies the
// full STUN+TURN list via fetchIceServers; this is used only if that fetch fails.
const STUN = [{ urls: "stun:turn-us1.whipdesk.com:3478" }];

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
 * Remote transport: a WebRTC DataChannel to the agent, brokered by Firestore signaling.
 * Mirrors `Connection`'s surface (on/send/submitPin/setVisible/connect/close) by wrapping
 * the same `ControllerCore`, so the rest of the app doesn't care which transport is active.
 *
 * The data path is pure P2P + DTLS-encrypted; Firestore only carries the SDP offer/answer.
 * Frames arrive chunked ([1-byte continuation flag][payload]) and are reassembled here.
 */
export class RemoteConnection {
  private readonly core: ControllerCore;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mainXcv: RTCRtpTransceiver | null = null;
  private overviewXcv: RTCRtpTransceiver | null = null;
  private cleanupSignal: (() => void) | null = null;
  // Deletes this session's signaling node on teardown / tab death. Trickle keeps the node alive
  // through the session; the agent TTL-sweeps it too.
  private deleteSessionDoc: (() => void) | null = null;
  // Trickle: publish our local ICE candidates as they arrive.
  private pushCandidate: ((cand: RTCIceCandidateInit) => void) | null = null;
  private appliedAnswer = false;
  private readonly appliedCandidates = new Set<string>();
  private closed = false;
  private reconnectTimer = 0;
  // getStats-driven link quality (fps + rtt) for the connection dialog.
  private statsTimer = 0;

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

  /** Tear down the current peer connection + signaling listener without ending reconnects. */
  private teardown(): void {
    window.clearInterval(this.statsTimer);
    this.statsTimer = 0;
    this.cleanupSignal?.();
    this.cleanupSignal = null;
    this.deleteSessionDoc?.();
    this.deleteSessionDoc = null;
    this.pushCandidate = null;
    this.appliedAnswer = false;
    this.appliedCandidates.clear();
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
    const { getDatabase, ref, child, push, set, onValue, remove, onDisconnect } = await import(
      "firebase/database"
    );

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
    const db = getDatabase(app);

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
      // One write per connection. Stats are PERSISTENT user data -> Firestore.
      const key = kind === "TURN" ? "turn" : kind === "STUN" ? "stun" : "lan";
      try {
        const { getFirestore, doc, setDoc, increment } = await import("firebase/firestore");
        void setDoc(doc(getFirestore(app), "users", uid), { stats: { [key]: increment(1) } }, { merge: true }).catch(
          () => {},
        );
      } catch {
        /* stats are best-effort */
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        this.core.emit("status", "connected");
        void reportTransport();
        this.startStatsPoll(pc);
      } else if (s === "failed" || s === "disconnected" || s === "closed") {
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    // Trickle ICE: publish the offer immediately (no gather wait) and stream candidates BOTH ways
    // through the session node, so the connection forms as candidates arrive.
    const sessionRef = push(ref(db, `signaling/${uid}/${this.deviceId}`));
    this.pushCandidate = (cand) => {
      try {
        void set(push(child(sessionRef, "offerCandidates")), cand);
      } catch {
        /* best-effort */
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.pushCandidate?.(ev.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(sessionRef, {
      offer: { sdp: pc.localDescription?.sdp ?? "" },
      controllerUid: uid,
      createdAtMs: Date.now(),
    });
    // Auto-remove our offer if this tab dies; the agent also TTL-sweeps it.
    void onDisconnect(sessionRef).remove();
    this.deleteSessionDoc = () => void remove(sessionRef).catch(() => {});

    this.cleanupSignal = onValue(sessionRef, (snap) => {
      const val = snap.val() as
        | { answer?: { sdp?: string }; answerCandidates?: Record<string, RTCIceCandidateInit> }
        | null;
      if (!val || this.closed) return;
      if (val.answer?.sdp && !this.appliedAnswer) {
        this.appliedAnswer = true;
        void pc.setRemoteDescription({ type: "answer", sdp: val.answer.sdp });
      }
      if (val.answerCandidates && this.appliedAnswer) {
        for (const [k, cand] of Object.entries(val.answerCandidates)) {
          if (this.appliedCandidates.has(k)) continue;
          this.appliedCandidates.add(k);
          try {
            void pc.addIceCandidate(cand);
          } catch {
            /* late/invalid candidate */
          }
        }
      }
    });
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

  /** Fetch STUN-first + ephemeral TURN servers from the backend (auth-gated). Cached in
   * sessionStorage so reconnects don't pay the Cloud Function (cold-start) cost. Falls back to STUN. */
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
      const url =
        this.config.iceUrl || `https://us-central1-${this.config.projectId}.cloudfunctions.net/iceServers`;
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
