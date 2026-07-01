import type { ClientMessage } from "@whipdesk/protocol";
import { ControllerCore, type ConnectionStatus, type ControllerEvents, type PinRequest } from "./core";

export type { ConnectionStatus, PinRequest } from "./core";

/**
 * LAN transport: WebRTC to the agent with signaling over a WebSocket and ICE using ONLY host
 * candidates (`iceServers: []`) — a same-Wi-Fi connection never touches STUN/TURN. The screen
 * arrives as a single H.264 video track exactly like the remote path; only signaling differs.
 * Wraps the shared ControllerCore so the rest of the app is transport-agnostic.
 */
export class Connection {
  private readonly core: ControllerCore;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mainXcv: RTCRtpTransceiver | null = null;
  private overviewXcv: RTCRtpTransceiver | null = null;
  private reconnectTimer = 0;
  private statsTimer = 0;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    token: string,
  ) {
    this.core = new ControllerCore(token);
    this.core.setSender((text) => {
      if (this.dc && this.dc.readyState === "open") {
        try {
          this.dc.send(text);
        } catch {
          /* dropped — input is best-effort */
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
    this.closedByUser = false;
    this.open();
  }
  close(): void {
    this.closedByUser = true;
    window.clearTimeout(this.reconnectTimer);
    this.teardown();
  }

  isHealthy(): boolean {
    return !this.closedByUser && this.dc?.readyState === "open" && this.pc?.connectionState === "connected";
  }

  /** Foreground resume: rebuild immediately if the link isn't healthy (see ControllerTransport). */
  wake(): void {
    if (this.closedByUser || this.isHealthy()) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.open(); // open() tears down any half-dead socket/pc first
  }

  private teardown(): void {
    window.clearInterval(this.statsTimer);
    this.statsTimer = 0;
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
      this.pc.onicecandidate = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.mainXcv = null;
    this.overviewXcv = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.open(), 1500);
  }

  private open(): void {
    this.core.emit("status", "connecting");
    this.teardown();

    const ws = new WebSocket(this.url);
    this.ws = ws;
    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          /* socket may have closed */
        }
      }
    };

    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates only.
    this.pc = pc;
    const dc = pc.createDataChannel("whipdesk");
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    dc.onopen = () => {
      this.core.sendHello();
      this.core.emit("status", "connected");
      this.core.emit("transport", "LAN");
      this.startStatsPoll(pc);
    };
    dc.onclose = () => this.core.emit("status", "disconnected");
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") this.core.handleText(ev.data);
    };

    try {
      // Two recvonly m-lines: [0] main desktop, [1] low-res full-desktop overview (frames only while
      // the main is cropped). The agent answers each sendonly; ontrack routes them apart by xcv.
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
    pc.onicecandidate = (ev) => {
      if (ev.candidate) send({ kind: "candidate", candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this.core.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    let answered = false;
    ws.onopen = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ kind: "offer", sdp: pc.localDescription?.sdp ?? "" });
      } catch {
        /* the close/reconnect path will retry */
      }
    };
    ws.onmessage = (event) => {
      let msg: { kind?: string; sdp?: string; candidate?: RTCIceCandidateInit; message?: string };
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (msg.kind === "answer" && msg.sdp && !answered) {
        answered = true;
        void pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } else if (msg.kind === "candidate" && msg.candidate) {
        try {
          void pc.addIceCandidate(msg.candidate);
        } catch {
          /* late/invalid candidate */
        }
      } else if (msg.kind === "error") {
        this.core.emit("error", String(msg.message ?? "host error"));
      }
    };
    ws.onclose = () => {
      this.core.emit("status", "disconnected");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* a close event always follows; reconnect handled there */
    };
  }

  private startStatsPoll(pc: RTCPeerConnection): void {
    window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(async () => {
      let rtt: number | null = null;
      let fps = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach((r: any) => {
          if (r.type === "inbound-rtp" && r.kind === "video") fps = Math.max(fps, Number(r.framesPerSecond ?? 0));
          else if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number")
            rtt = r.currentRoundTripTime as number;
        });
      } catch {
        return;
      }
      this.core.emit("netStats", { fps: Math.round(fps), rtt: rtt != null ? Math.round(rtt * 1000) : null });
    }, 1000);
  }
}
