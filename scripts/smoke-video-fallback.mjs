// Fallback case (the DEFAULT, no ffmpeg): a browser offers a recvonly video m-line, but the
// agent has NO video support (no codecs config, no track). The DataChannel (JPEG path) MUST
// still connect — the video m-line should just be rejected, not break negotiation.
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";

const ice = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const h264 = () => ({
  video: [
    new RTCRtpCodecParameters({
      mimeType: "video/H264",
      clockRate: 90000,
      payloadType: 96,
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

const offerer = new RTCPeerConnection({ ...ice, codecs: h264() }); // browser-like
// Agent WITHOUT ffmpeg: it still advertises the codec (so werift can negotiate the offered
// video m-line) but attaches NO track — so no video flows and JPEG carries the screen.
const answerer = new RTCPeerConnection({ ...ice, codecs: h264() });

let roundTrip = false;
const dc = offerer.createDataChannel("whipdesk");
offerer.addTransceiver("video", { direction: "recvonly" });
dc.stateChanged.subscribe((s) => {
  if (s === "open") dc.send("ping");
});
dc.onMessage.subscribe((d) => {
  if (String(d) === "pong") roundTrip = true;
});
answerer.onDataChannel.subscribe((ch) =>
  ch.onMessage.subscribe((d) => {
    if (String(d) === "ping") ch.send("pong");
  }),
);

try {
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await waitGather(offerer);
  await answerer.setRemoteDescription(offerer.localDescription);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await waitGather(answerer);
  await offerer.setRemoteDescription(answerer.localDescription);
} catch (e) {
  console.log(`negotiation threw: ${e.message}`);
  console.log("video-fallback smoke: FAIL ✗");
  process.exit(1);
}

setTimeout(() => {
  console.log(`dcRoundTrip=${roundTrip}`);
  console.log(roundTrip ? "video-fallback smoke: PASS ✓" : "video-fallback smoke: FAIL ✗");
  process.exit(roundTrip ? 0 : 1);
}, 4000);
