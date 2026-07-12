import { log } from "../logger";
import type { EdgeClient } from "../cloud/edge";
import type { IceServer } from "../cloud/ice";
import { answerWebRtcOffer, type WebRtcAnswer } from "../transport/webrtc";
import type { AgentContext } from "../server";

/**
 * Edge WebRTC signaling: controller offers arrive as `offer` messages on the agent's hub socket
 * (see cloud/edge.ts), we answer, and ICE candidates trickle both ways as `cand` messages. The
 * hub relays with ordered, exactly-once delivery, so there is no candidate de-dupe and no
 * re-delivered-session bookkeeping. The media path stays P2P DTLS;
 * control still requires the token + PIN like every other transport.
 */

export interface SignalingHandle {
  stop: () => void;
}

export function startSignaling(
  ctx: AgentContext,
  edge: EdgeClient,
  getIceServers: () => Promise<IceServer[]> = async () => [],
): SignalingHandle {
  const answers = new Map<string, WebRtcAnswer>();
  const pendingCands = new Map<string, unknown[]>();
  const answered = new Set<string>();
  let stopped = false;

  edge.on("offer", (msg) => {
    const sid = msg.sid;
    const offerSdp = msg.sdp;
    if (stopped || !sid || !offerSdp || answered.has(sid)) return;
    answered.add(sid);
    log.info(`cloud: incoming remote connection (session ${sid.slice(0, 6)}…)`);
    void (async () => {
      try {
        // Always advertise STUN+TURN. ICE prefers host/srflx over relay, so a viable P2P/STUN
        // pair wins on its own and TURN is used only as a genuine last resort.
        const iceServers = await getIceServers();
        const answer = await answerWebRtcOffer(
          ctx,
          offerSdp,
          () => {
            answers.delete(sid);
            pendingCands.delete(sid);
          },
          {
            // The hub only relays controllers signed in as the SAME user, so the uid is the
            // controller identity for PIN brute-force throttling.
            clientId: edge.uid,
            iceServers,
            onLocalCandidate: (candidate) => void edge.send({ t: "cand", sid, cand: candidate }),
          },
        );
        if (!answer) {
          answered.delete(sid);
          edge.send({ t: "end", sid });
          return;
        }
        answers.set(sid, answer);
        edge.send({ t: "answer", sid, sdp: answer.answerSdp });
        const buffered = pendingCands.get(sid);
        if (buffered) {
          for (const cand of buffered) answer.addCandidate(cand);
          pendingCands.delete(sid);
        }
      } catch (error) {
        log.warn("signaling answer failed:", (error as Error).message);
        answered.delete(sid);
      }
    })();
  });

  edge.on("cand", (msg) => {
    if (stopped || !msg.sid || !msg.cand) return;
    const answer = answers.get(msg.sid);
    if (answer) answer.addCandidate(msg.cand);
    else {
      // Ordered delivery means candidates always follow the offer, but our answer setup is
      // async — buffer the early ones until the peer exists.
      const list = pendingCands.get(msg.sid) ?? [];
      list.push(msg.cand);
      pendingCands.set(msg.sid, list);
    }
  });

  edge.on("end", (msg) => {
    // Controller finished signaling (or its tab died). Don't close the peer — the live P2P
    // session owns its own lifecycle via connectionstatechange; just forget the bookkeeping.
    if (!msg.sid) return;
    answered.delete(msg.sid);
    pendingCands.delete(msg.sid);
  });

  log.info("cloud: remote signaling ready (waiting for connections)");

  return {
    stop() {
      stopped = true;
      for (const answer of answers.values()) answer.close();
      answers.clear();
      pendingCands.clear();
    },
  };
}
