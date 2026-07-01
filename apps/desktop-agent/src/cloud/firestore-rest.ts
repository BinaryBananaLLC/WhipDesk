import { log } from "../logger";
import type { CloudConfig } from "./config";
import type { AgentAuth } from "./auth";

/**
 * Minimal Firestore REST client authenticated as the REAL signed-in user (idToken from
 * cloud/auth.ts). Device presence + WebRTC signaling moved to RTDB (see cloud/rtdb-rest.ts);
 * Firestore now backs ONLY the FCM push relay — the agent appends an alert to
 * users/{uid}/pushQueue and a Cloud Function delivers it via web push. These writes are rare
 * (they fire on real alerts, not on a timer), so Firestore's per-op pricing is a non-issue here.
 */

export interface FirestoreRest {
  uid: string;
  /** Append a notification to users/{uid}/pushQueue (a Cloud Function relays it via FCM). */
  createNotification(fields: Record<string, unknown>): Promise<void>;
}

export function createFirestoreRest(config: CloudConfig, auth: AgentAuth): FirestoreRest {
  const base = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;

  const authed = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const token = await auth.getIdToken();
    const res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  };

  return {
    uid: auth.uid,

    async createNotification(fields) {
      // POST to a collection => Firestore assigns an auto id, which fires the push function.
      await authed(`${base}/users/${auth.uid}/pushQueue`, {
        method: "POST",
        body: JSON.stringify({ fields: encodeFields(fields) }),
      });
    },
  };
}

// --- Firestore REST value serialization for the value types we use ---

function encodeValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  return { stringValue: String(v) };
}

function encodeFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) out[k] = encodeValue(val);
  return out;
}

export function logFirestoreReady(rest: FirestoreRest): void {
  log.info(`cloud: Firestore ready as ${rest.uid}`);
}
