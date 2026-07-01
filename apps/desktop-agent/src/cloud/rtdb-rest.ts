import { log } from "../logger";
import type { CloudConfig } from "./config";
import type { AgentAuth } from "./auth";

/**
 * Minimal Realtime Database REST client authenticated as the REAL signed-in user (idToken from
 * cloud/auth.ts). RTDB replaces Firestore for the two always-on workloads — device presence and
 * WebRTC signaling — because it bills by *bandwidth*, not per-operation, and (crucially) its
 * REST API supports STREAMING. So instead of polling for offers (which charged a Firestore read
 * on every tick, forever), the agent holds one Server-Sent-Events stream open: idle costs $0 and
 * offers arrive instantly. Writes/uploads are free, so the presence heartbeat is free too.
 *
 * Everything is namespaced under the user's uid (devices/{uid}/…, signaling/{uid}/…) and the
 * idToken is passed as `?auth=` — see database.rules.json.
 */

export interface SessionData {
  offer?: { sdp?: string };
  answer?: { sdp?: string };
  controllerUid?: string;
  createdAtMs?: number;
  /** The controller's trickled ICE candidates (caller side), keyed by push id. */
  offerCandidates?: Record<string, unknown>;
}

export interface RtdbRest {
  uid: string;
  /** Overwrite the full device presence/registry record. */
  putDevice(deviceId: string, fields: Record<string, unknown>): Promise<void>;
  /** Merge a few fields (used for the cheap presence heartbeat). */
  patchDevice(deviceId: string, fields: Record<string, unknown>): Promise<void>;
  /** Publish our SDP answer for a controller's session. */
  setSessionAnswer(deviceId: string, sessionId: string, sdp: string): Promise<void>;
  /** Publish one of our (trickled) ICE candidates for a controller's session. */
  pushAnswerCandidate(deviceId: string, sessionId: string, candidate: unknown): Promise<void>;
  /** Remove a consumed/stale signaling node. */
  deleteSession(deviceId: string, sessionId: string): Promise<void>;
  /**
   * Stream the device's signaling node. `onSession` fires for each session that appears or
   * changes; `onCandidate` for each trickled controller ICE candidate; `onRemoved` when one is
   * deleted. Returns a stop fn. Reconnects on error and refreshes the auth token internally.
   */
  watchSessions(
    deviceId: string,
    onSession: (id: string, data: SessionData) => void,
    onCandidate: (id: string, candidate: unknown) => void,
    onRemoved: (id: string) => void,
  ): () => void;
}

// Firebase ID tokens last ~1h; reconnect the stream comfortably before that so `?auth=` stays valid.
const STREAM_REFRESH_MS = 50 * 60_000;
const STREAM_RETRY_MS = 3000;

export function createRtdbRest(config: CloudConfig, auth: AgentAuth): RtdbRest {
  const base = (config.databaseURL ?? `https://${config.projectId}-default-rtdb.firebaseio.com`).replace(/\/$/, "");

  const writeJson = async (path: string, method: "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<void> => {
    const token = await auth.getIdToken();
    const res = await fetch(`${base}/${path}.json?auth=${token}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RTDB ${method} ${path} -> HTTP ${res.status} ${text}`.trim());
    }
  };

  return {
    uid: auth.uid,

    putDevice(deviceId, fields) {
      return writeJson(`devices/${auth.uid}/${deviceId}`, "PUT", fields);
    },
    patchDevice(deviceId, fields) {
      return writeJson(`devices/${auth.uid}/${deviceId}`, "PATCH", fields);
    },
    setSessionAnswer(deviceId, sessionId, sdp) {
      return writeJson(`signaling/${auth.uid}/${deviceId}/${sessionId}/answer`, "PUT", { sdp });
    },
    pushAnswerCandidate(deviceId, sessionId, candidate) {
      const key = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      return writeJson(
        `signaling/${auth.uid}/${deviceId}/${sessionId}/answerCandidates/${key}`,
        "PUT",
        candidate,
      );
    },
    deleteSession(deviceId, sessionId) {
      return writeJson(`signaling/${auth.uid}/${deviceId}/${sessionId}`, "DELETE");
    },

    watchSessions(deviceId, onSession, onCandidate, onRemoved) {
      let stopped = false;
      let abort: AbortController | null = null;
      let retry: ReturnType<typeof setTimeout> | null = null;

      // RTDB SSE delivers {path, data}: path "/" is the whole node, "/{id}" a single session, and
      // deeper paths are nested writes. We route the controller's trickled candidates
      // ("/{id}/offerCandidates/...") and ignore our own answer/answerCandidates writes.
      const candidatesOf = (id: string, data: SessionData) => {
        if (data.offerCandidates) for (const c of Object.values(data.offerCandidates)) onCandidate(id, c);
      };
      const route = (path: string, data: unknown) => {
        if (path === "/") {
          if (data && typeof data === "object") {
            for (const [id, val] of Object.entries(data as Record<string, unknown>)) {
              if (val && typeof val === "object") {
                onSession(id, val as SessionData);
                candidatesOf(id, val as SessionData);
              }
            }
          }
          return;
        }
        const parts = path.replace(/^\//, "").split("/");
        const id = parts[0]!;
        if (parts.length === 1) {
          if (data === null) onRemoved(id);
          else if (data && typeof data === "object") {
            onSession(id, data as SessionData);
            candidatesOf(id, data as SessionData);
          }
          return;
        }
        if (parts[1] === "offerCandidates" && data) {
          if (parts.length === 2 && typeof data === "object") {
            for (const c of Object.values(data as Record<string, unknown>)) onCandidate(id, c);
          } else if (parts.length === 3) {
            onCandidate(id, data);
          }
        }
      };

      const handleBlock = (block: string) => {
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!event || event === "keep-alive") return;
        if (event === "cancel" || event === "auth_revoked") {
          abort?.abort(); // rules/token problem — drop and reconnect with a fresh token
          return;
        }
        if (event !== "put" && event !== "patch") return;
        try {
          const payload = JSON.parse(data) as { path: string; data: unknown };
          route(payload.path, payload.data);
        } catch {
          /* ignore malformed frame */
        }
      };

      const connect = async () => {
        if (stopped) return;
        abort = new AbortController();
        const refresh = setTimeout(() => abort?.abort(), STREAM_REFRESH_MS);
        refresh.unref?.();
        try {
          const token = await auth.getIdToken();
          const res = await fetch(`${base}/signaling/${auth.uid}/${deviceId}.json?auth=${token}`, {
            headers: { Accept: "text/event-stream" },
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              handleBlock(buf.slice(0, idx));
              buf = buf.slice(idx + 2);
            }
          }
        } catch (error) {
          if (!stopped && (error as Error).name !== "AbortError") {
            log.warn("signaling stream error:", (error as Error).message);
          }
        } finally {
          clearTimeout(refresh);
          if (!stopped) {
            retry = setTimeout(connect, STREAM_RETRY_MS);
            retry.unref?.();
          }
        }
      };

      void connect();
      return () => {
        stopped = true;
        abort?.abort();
        if (retry) clearTimeout(retry);
      };
    },
  };
}
