// Quick validation that werift can establish a DataChannel on this Node version.
// Two local peers exchange SDP (with gathered ICE) and echo a message over the channel.
import { RTCPeerConnection } from "werift";

const ice = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function waitGather(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") resolve();
    };
    pc.iceGatheringStateChange.subscribe(check);
    setTimeout(resolve, 2000); // host candidates are enough for localhost
  });
}

const offerer = new RTCPeerConnection(ice);
const answerer = new RTCPeerConnection(ice);

const dc = offerer.createDataChannel("whipdesk");
let done = false;
const finish = (ok, msg) => {
  if (done) return;
  done = true;
  console.log(ok ? `PASS: ${msg}` : `FAIL: ${msg}`);
  process.exit(ok ? 0 : 1);
};

dc.stateChanged.subscribe((s) => {
  if (s === "open") dc.send("ping");
});
dc.onMessage.subscribe((data) => {
  if (String(data) === "pong") finish(true, "DataChannel round-trip works on Node " + process.version);
});

answerer.onDataChannel.subscribe((channel) => {
  channel.onMessage.subscribe((data) => {
    if (String(data) === "ping") channel.send("pong");
  });
});

const offer = await offerer.createOffer();
await offerer.setLocalDescription(offer);
await waitGather(offerer);
await answerer.setRemoteDescription(offerer.localDescription);
const answer = await answerer.createAnswer();
await answerer.setLocalDescription(answer);
await waitGather(answerer);
await offerer.setRemoteDescription(answerer.localDescription);

setTimeout(() => finish(false, "timed out waiting for DataChannel"), 12000);
