import { log } from "../logger";
import type { RtdbRest, SessionData } from "../cloud/rtdb-rest";
import type { DeviceIdentity } from "../cloud/config";
import type { IceServer } from "../cloud/ice";
import { answerWebRtcOffer, type WebRtcAnswer } from "../transport/webrtc";
import type { AgentContext } from "../server";

/**
 * Realtime-Database WebRTC signaling, authenticated as the REAL user via REST. The agent holds
 * ONE streaming listener on signaling/{uid}/{deviceId} (see cloud/rtdb-rest.ts) and answers
 * controller offers as they're pushed — no polling, so an idle agent costs nothing. RTDB carries
 * ONLY the SDP handshake; the media path is the P2P DTLS DataChannel and control still requires
 * the token + PIN.
 *
 * Data model: signaling/{uid}/{deviceId}/{sessionId}
 *   { offer: { sdp }, answer: { sdp }, createdAtMs, controllerUid }
 *
 * Cleanup: the controller removes its own session once it applies our answer (and via
 * onDisconnect if its tab dies); we also sweep stale/answered nodes as a fallback so the
 * subcollection can't accumulate.
 */

export interface SignalingHandle {
  stop: () => void;
}

const SESSION_TTL_MS = 2 * 60_000; // ignore/sweep offers older than 2 minutes

export async function startSignaling(
  ctx: AgentContext,
  rtdb: RtdbRest,
  identity: DeviceIdentity,
  getIceServers: () => Promise<IceServer[]> = async () => [],
): Promise<SignalingHandle | null> {
  const answered = new Set<string>();
  const answers = new Map<string, WebRtcAnswer>();
  const pendingCands = new Map<string, unknown[]>();
  const appliedCands = new Map<string, Set<string>>();
  let stopped = false;

  const drop = (id: string) =>
    rtdb.deleteSession(identity.deviceId, id).catch(() => {
      /* swept on a later event, or already gone */
    });

  const applyCandidate = (id: string, answer: WebRtcAnswer, cand: unknown) => {
    let applied = appliedCands.get(id);
    if (!applied) appliedCands.set(id, (applied = new Set()));
    const key = JSON.stringify(cand);
    if (applied.has(key)) return; // RTDB re-delivers the whole candidate map; de-dupe.
    applied.add(key);
    answer.addCandidate(cand);
  };

  const onCandidate = (id: string, cand: unknown) => {
    if (stopped || !cand) return;
    const answer = answers.get(id);
    if (answer) applyCandidate(id, answer, cand);
    else {
      const list = pendingCands.get(id) ?? [];
      list.push(cand);
      pendingCands.set(id, list);
    }
  };

  const onSession = async (id: string, data: SessionData) => {
    if (stopped || answered.has(id)) return;
    const offerSdp = data.offer?.sdp;
    if (!offerSdp || data.answer) return;
    if (Date.now() - Number(data.createdAtMs ?? Date.now()) > SESSION_TTL_MS) {
      void drop(id);
      return;
    }

    // Defense in depth: the RTDB rules already scope this stream to our own uid, but verify the
    // offer's controllerUid matches us so a misconfigured rule can never let another user in.
    if (data.controllerUid && data.controllerUid !== rtdb.uid) {
      log.warn("cloud: rejected signaling offer (controllerUid mismatch)");
      void drop(id);
      return;
    }

    answered.add(id);
    log.info(`cloud: incoming remote connection (session ${id.slice(0, 6)}…)`);
    try {
      // Always advertise STUN+TURN. ICE prefers host/srflx over relay, so a viable P2P/STUN pair
      // wins on its own and TURN is used only as a genuine last resort — no probe, no rebuild.
      const iceServers = await getIceServers();
      const answer = await answerWebRtcOffer(
        ctx,
        offerSdp,
        () => {
          answers.delete(id);
          appliedCands.delete(id);
        },
        {
          clientId: data.controllerUid ?? rtdb.uid,
          iceServers,
          onLocalCandidate: (candidate) =>
            void rtdb.pushAnswerCandidate(identity.deviceId, id, candidate).catch(() => {}),
        },
      );
      if (!answer) {
        answered.delete(id);
        void drop(id);
        return;
      }
      answers.set(id, answer);
      await rtdb.setSessionAnswer(identity.deviceId, id, answer.answerSdp);
      const buffered = pendingCands.get(id);
      if (buffered) {
        for (const c of buffered) applyCandidate(id, answer, c);
        pendingCands.delete(id);
      }
      // Sweep the node well after ICE has completed; the live P2P connection is independent of it.
      setTimeout(() => void drop(id), SESSION_TTL_MS).unref?.();
    } catch (error) {
      log.warn("signaling answer failed:", (error as Error).message);
      answered.delete(id);
    }
  };

  const stop = rtdb.watchSessions(
    identity.deviceId,
    (id, data) => void onSession(id, data),
    (id, cand) => onCandidate(id, cand),
    (id) => {
      // Node removed (controller cleaned up after connecting). Don't close the peer — it owns its
      // own lifecycle via connectionStateChange; just forget the bookkeeping.
      answered.delete(id);
      pendingCands.delete(id);
    },
  );
  log.info("cloud: remote signaling ready (waiting for connections)");

  return {
    stop() {
      stopped = true;
      stop();
      for (const a of answers.values()) a.close();
      answers.clear();
    },
  };
}
