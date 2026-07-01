// Validates the Phase 2 WebRTC video path on werift the way the agent uses it:
//  - the controller offers a DataChannel + a recvonly VIDEO transceiver (apps/mobile-web/remote.ts)
//  - the agent answers with an H.264 send track (apps/desktop-agent/transport/webrtc.ts)
//  - the DataChannel still round-trips, the controller sees the track, and track.writeRtp works.
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RtpPacket,
  RtpHeader,
} from "werift";

const ice = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
// A browser offerer natively supports H.264; simulate that by giving both werift peers the
// same H.264 codec so this test represents browser(offer) <-> agent(answer).
const h264 = () => ({
  video: [
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90000,
      payloadType: 96,
      rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }],
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    }),
  ],
});
async function waitGather(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    pc.iceGatheringStateChange.subscribe(() => pc.iceGatheringState === "complete" && resolve());
    setTimeout(resolve, 2000);
  });
}

const offerer = new RTCPeerConnection({ ...ice, codecs: h264() });
const answerer = new RTCPeerConnection({ ...ice, codecs: h264() });

let dcRoundTrip = false;
let trackSeen = false;
let rtpOk = false;

const dc = offerer.createDataChannel("whipdesk");
offerer.addTransceiver("video", { direction: "recvonly" });
offerer.onTrack.subscribe(() => {
  trackSeen = true;
});
dc.stateChanged.subscribe((s) => {
  if (s === "open") dc.send("ping");
});
dc.onMessage.subscribe((d) => {
  if (String(d) === "pong") dcRoundTrip = true;
});
answerer.onDataChannel.subscribe((ch) =>
  ch.onMessage.subscribe((d) => {
    if (String(d) === "ping") ch.send("pong");
  }),
);

// Agent side: attach an H.264 send track before answering.
const track = new MediaStreamTrack({ kind: "video" });
answerer.addTrack(track);

const offer = await offerer.createOffer();
await offerer.setLocalDescription(offer);
await waitGather(offerer);
await answerer.setRemoteDescription(offerer.localDescription);
const answer = await answerer.createAnswer();
await answerer.setLocalDescription(answer);
await waitGather(answerer);
await offerer.setRemoteDescription(answerer.localDescription);

const finish = () => {
  // Re-stamp + write one dummy RTP packet exactly like the agent's fan-out sink.
  try {
    const hdr = new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 0, ssrc: track.ssrc || 1, marker: true });
    const buf = new RtpPacket(hdr, Buffer.alloc(32)).serialize();
    const pkt = RtpPacket.deSerialize(buf);
    pkt.header.payloadType = 96;
    if (track.ssrc) pkt.header.ssrc = track.ssrc;
    track.writeRtp(pkt);
    rtpOk = true;
  } catch (e) {
    rtpOk = `threw: ${e.message}`;
  }
  const ok = dcRoundTrip && trackSeen && rtpOk === true;
  console.log(`dcRoundTrip=${dcRoundTrip} trackSeen=${trackSeen} rtpWrite=${rtpOk}`);
  console.log(ok ? "video smoke: PASS ✓" : "video smoke: FAIL ✗");
  process.exit(ok ? 0 : 1);
};

setTimeout(finish, 4000);
