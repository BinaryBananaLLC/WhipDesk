import { optionalImport } from "../util/optional-import";
import { log } from "../logger";
import type { AgentContext } from "../server";
import { createControllerSession, type RawChannel } from "./session";
import { VIDEO_CLOCK_RATE, VIDEO_PAYLOAD_TYPE, type VideoTrackSink } from "../capture/encoder";

/**
 * Re-stamps the RTP we forward to the browser onto ONE continuous sequence-number + timestamp
 * timeline, independent of the ffmpeg process underneath.
 *
 * WHY THIS EXISTS (the "zoom is stretched/frozen" bug): the shared screen capture is a single
 * ffmpeg that we RESTART whenever the controller settles a zoom (server-side re-crop) or switches
 * display — see encoder.ts. Each new ffmpeg's RTP muxer starts its sequence numbers and timestamps
 * at a fresh RANDOM base, yet we keep the WebRTC track's SSRC constant. werift forwards the
 * packet's seq/timestamp unchanged (its sender offsets default to 0), so to the browser it looks
 * like the SAME stream suddenly jumping thousands of packets backwards/forwards. Its jitter buffer
 * then discards every post-restart (sharp, cropped) frame and the <video> freezes on the last
 * pre-zoom frame — which the controller keeps digitally upscaling, i.e. the stretched/blurry zoom.
 *
 * Fixing it here keeps the receiver oblivious to encoder restarts: the sequence number increments
 * by exactly 1 per emitted packet forever (so a restart looks like zero loss, just a brief silence),
 * and the timestamp advances by REAL elapsed time at each new frame (so playback never jumps in
 * time). The fresh IDR ffmpeg emits on start then re-syncs the decoder cleanly.
 */
class RtpRestamper {
  private seq = Math.floor(Math.random() * 0x10000);
  private ts = Math.floor(Math.random() * 0x100000000);
  private lastInTs: number | null = null;
  private lastFrameAt = 0;

  /** Rewrite this packet header's sequenceNumber + timestamp in place onto the continuous timeline. */
  stamp(header: { sequenceNumber: number; timestamp: number }): void {
    const inTs = header.timestamp >>> 0;
    const now = Date.now();
    if (this.lastInTs === null) {
      this.lastFrameAt = now;
    } else if (inTs !== this.lastInTs) {
      // New frame (the RTP timestamp changed): advance our clock by the real time since the last
      // frame, at the 90 kHz video clock. Packets WITHIN a frame share one timestamp, so we only
      // advance on a change — across an encoder restart this is just a slightly longer gap.
      const dtMs = Math.max(1, now - this.lastFrameAt);
      this.lastFrameAt = now;
      this.ts = (this.ts + Math.round(dtMs * (VIDEO_CLOCK_RATE / 1000))) >>> 0;
    }
    this.lastInTs = inTs;
    header.timestamp = this.ts;
    header.sequenceNumber = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
  }
}

/**
 * Phase 2 — WebRTC P2P answerer. Establishes a DTLS-encrypted DataChannel directly with a
 * remote controller for off-LAN control. No relay: once connected, frames + input flow
 * peer-to-peer. Firebase is used only for the SDP handshake (see ../signaling/rtdb.ts);
 * STUN-first with ephemeral-credential TURN as the fallback for NAT-blocked peers.
 *
 * Uses `werift` (pure-TS WebRTC) so it runs on bleeding-edge Node with no native build.
 * Non-trickle ICE: we wait for gathering to finish and exchange a single offer/answer pair,
 * which keeps the signaling to one offer/answer round-trip.
 */

/** Our own STUN (no public/free STUN). The signaling layer normally passes the full STUN+TURN
 * list from the backend; this is only the fallback. */
export function stunServers(): { urls: string }[] {
  return [{ urls: "stun:turn-us1.whipdesk.com:3478" }];
}

export interface WebRtcAnswer {
  answerSdp: string;
  /** Feed a remote (controller) ICE candidate (trickle). */
  addCandidate: (candidate: unknown) => void;
  close: () => void;
}

/** An ICE server entry (STUN, or TURN with ephemeral credentials — see signaling/rtdb.ts). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface AnswerOptions {
  /** Controller identity (uid) for PIN brute-force throttling. */
  clientId?: string;
  /** Full ICE server list (STUN + ephemeral TURN). Falls back to public STUN when omitted. */
  iceServers?: IceServer[];
  /** Trickle: called with each local ICE candidate to publish to the controller. */
  onLocalCandidate?: (candidate: unknown) => void;
}

/**
 * Accepts a controller's SDP offer, returns our SDP answer, and wires the resulting DataChannel
 * into the shared controller session. Trickle ICE: local candidates are surfaced via
 * `opts.onLocalCandidate`, remote candidates fed back via the returned `addCandidate` — neither
 * side blocks on full ICE gathering. The controller offers TWO video m-lines (main + overview).
 */
export async function answerWebRtcOffer(
  ctx: AgentContext,
  offerSdp: string,
  onClosed?: () => void,
  opts: AnswerOptions = {},
): Promise<WebRtcAnswer | null> {
  const werift = await optionalImport("werift");
  if (!werift) {
    log.warn("WebRTC requested but `werift` is not installed — run `npm i werift` in apps/desktop-agent");
    return null;
  }
  const { RTCPeerConnection, MediaStreamTrack, RtpPacket, RTCRtpCodecParameters } = werift;

  // The controller always offers a recvonly video m-line. We must ADVERTISE a matching codec so
  // werift can negotiate it even when we won't send video (no ffmpeg) — otherwise
  // setRemoteDescription throws "negotiate codecs failed" and the JPEG DataChannel never opens.
  // We only attach an actual send track when the host can encode (ffmpeg + opt-in).
  const offerVideoCount = (offerSdp.match(/m=video/g) ?? []).length;
  const canSendVideo = ctx.videoAvailable && !!ctx.video;
  const pcConfig: any = { iceServers: opts.iceServers ?? stunServers() };
  if (offerVideoCount > 0) {
    pcConfig.codecs = {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: VIDEO_CLOCK_RATE,
          payloadType: VIDEO_PAYLOAD_TYPE,
          rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }],
          parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        }),
      ],
    };
  }

  const pc = new RTCPeerConnection(pcConfig);
  let session: ReturnType<typeof createControllerSession> | null = null;
  const sinks: VideoTrackSink[] = [];
  const overviewSinks: VideoTrackSink[] = [];

  // SECURITY: the screen video tracks are negotiated up front (SDP requires them) but are NOT
  // wired to the encoder until the controller passes the token + PIN gate. `attachVideo` runs from
  // the session's `onAuthenticated` (i.e. inside admit()), so not one desktop frame is encoded or
  // sent while the PIN dialog is still up. Until then the controller sees only an empty track.
  let authenticated = false;
  const pendingAttach: Array<() => void> = [];
  const attachVideo = () => {
    authenticated = true;
    for (const fn of pendingAttach.splice(0)) fn();
  };

  pc.onDataChannel.subscribe((dc: any) => {
    if (dc.label !== "whipdesk") return;

    const channel: RawChannel = {
      sendText: (text) => {
        try {
          dc.send(text);
        } catch {
          /* channel may be closing */
        }
      },
      close: () => {
        try {
          dc.close();
        } catch {
          /* ignore */
        }
      },
    };

    session = createControllerSession(ctx, channel, {
      clientId: opts.clientId,
      onAuthenticated: attachVideo,
    });

    dc.onMessage.subscribe((data: Buffer | string) => {
      // Controllers only ever send JSON control messages (text).
      if (typeof data === "string") session?.handleText(data);
    });
    dc.stateChanged.subscribe((s: string) => {
      if (s === "closed") session?.handleClose();
    });
  });

  // Trickle: surface our ICE candidates as they're found so the controller can start connecting
  // immediately instead of waiting for the whole SDP to finish gathering.
  if (opts.onLocalCandidate) {
    try {
      pc.onIceCandidate.subscribe((candidate: any) => {
        if (candidate) opts.onLocalCandidate!(candidate.toJSON ? candidate.toJSON() : candidate);
      });
    } catch {
      /* older werift: candidates ride in the SDP */
    }
  }

  // The P2P connection owns its own lifecycle: when it dies, close the session AND the peer.
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    session?.handleClose();
    if (ctx.video) {
      for (const s of sinks) ctx.video.detach(s);
      for (const s of overviewSinks) ctx.video.detachOverview(s);
    }
    sinks.length = 0;
    overviewSinks.length = 0;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    onClosed?.();
  };
  pc.connectionStateChange.subscribe((s: string) => {
    if (s === "failed" || s === "closed" || s === "disconnected") teardown();
  });
  // A controller that vanishes without a clean close (page refresh, tab kill, network drop) is
  // detected by werift's ICE consent-freshness checks (RFC 7675) — but that only moves the ICE
  // state to "disconnected" and stops there; `connectionStateChange` (DTLS-level) never fires and
  // werift never recovers the pair. Without this subscription the dead session would be counted as
  // a viewer forever (the "Viewers goes up on every refresh" bug).
  pc.iceConnectionStateChange.subscribe((s: string) => {
    if (s === "failed" || s === "closed" || s === "disconnected") teardown();
  });

  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });

  // Negotiate the send track(s) BEFORE createAnswer so werift answers each video m-line sendonly. RTP
  // from the shared ffmpeg capture is re-stamped onto each track's ssrc. The controller offers up to
  // TWO m-lines: [0] the main full/cropped desktop, [1] the low-res full-desktop overview that flows
  // only while the main is cropped (same single capture, split into two encodes — see encoder.ts).
  // Any further m-lines get an inert track (no RTP). The hub attach (which spawns ffmpeg + starts the
  // RTP) is DEFERRED until PIN auth — see above.
  if (offerVideoCount > 0 && canSendVideo && ctx.video) {
    for (let i = 0; i < offerVideoCount; i++) {
      try {
        const track = new MediaStreamTrack({ kind: "video" });
        pc.addTrack(track);
        if (i > 1) continue; // only main + overview carry RTP
        const isOverview = i === 1;
        // One restamper per track keeps its seq/timestamp continuous across ffmpeg re-crops/restarts
        // (otherwise the browser freezes on the pre-zoom frame — see RtpRestamper above).
        const restamper = new RtpRestamper();
        const sink: VideoTrackSink = {
          writeRtp: (packet) => {
            try {
              const pkt = RtpPacket.deSerialize(packet);
              pkt.header.payloadType = VIDEO_PAYLOAD_TYPE;
              if (track.ssrc) pkt.header.ssrc = track.ssrc;
              restamper.stamp(pkt.header);
              track.writeRtp(pkt);
            } catch {
              /* malformed/late packet — skip */
            }
          },
        };
        (isOverview ? overviewSinks : sinks).push(sink);
        const run = () => void (isOverview ? ctx.video!.attachOverview(sink) : ctx.video!.attach(sink));
        if (authenticated) run();
        else pendingAttach.push(run);
      } catch (error) {
        log.warn(`video track ${i} setup failed:`, (error as Error).message);
      }
    }
    log.info("cloud: WebRTC video negotiated (H.264 main + overview, attaches after PIN)");
  }

  // Trickle: return the answer immediately (candidates flow separately via onLocalCandidate).
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  return {
    answerSdp: pc.localDescription.sdp,
    addCandidate: (cand: any) => {
      try {
        void pc.addIceCandidate(cand);
      } catch {
        /* late/invalid candidate — ignore */
      }
    },
    close: teardown,
  };
}
