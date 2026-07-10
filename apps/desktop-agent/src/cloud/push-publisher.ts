import { log } from "../logger";
import type { NotificationHub } from "../notifications";
import type { FirestoreRest } from "./firestore-rest";

export interface PushPublisherHandle {
  stop(): void;
}

// Skip mirroring our own noisy/local notifications; the user wants real alerts (region
// changes, webhooks, file watchers), not connection chatter.
const SKIP_SOURCES = new Set(["client", "push"]);
const MIN_GAP_MS = 1000; // light throttle so a burst can't spam Firestore writes / FCM

/**
 * Mirrors agent notifications into Firestore (users/{uid}/pushQueue) so a Cloud Function can
 * deliver them as FCM web pushes — letting the user receive screen-change alerts even when
 * the controller PWA is closed. Cloud-mode only; best-effort (failures are logged, never
 * thrown). The Cloud Function and Firestore rules live in the web project.
 */
export function startPushPublisher(
  hub: NotificationHub,
  rest: FirestoreRest,
  deviceId?: string,
): PushPublisherHandle {
  let last = 0;
  const unsubscribe = hub.subscribe((n) => {
    if (SKIP_SOURCES.has(n.source)) return;
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return;
    last = now;
    void rest
      .createNotification({
        title: n.title,
        body: n.body ?? "",
        level: n.level,
        source: n.source,
        t: n.t,
        // Lets the Cloud Function deep-link the notification click back to THIS machine on the
        // dashboard (a plain /app/ open has no #token+device and is a dead page).
        ...(deviceId ? { machine: deviceId } : {}),
      })
      .catch((error) => log.warn("push relay write failed:", (error as Error).message));
  });
  log.info("cloud: push relay active — alerts also delivered via FCM when the app is closed");
  return { stop: unsubscribe };
}
