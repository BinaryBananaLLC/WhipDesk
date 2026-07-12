import { log } from "../logger";
import type { NotificationHub } from "../notifications";
import type { EdgeClient } from "./edge";

export interface PushPublisherHandle {
  stop(): void;
}

// Skip mirroring our own noisy/local notifications; the user wants real alerts (region
// changes, webhooks, file watchers), not connection chatter.
const SKIP_SOURCES = new Set(["client", "push"]);
const MIN_GAP_MS = 1000; // light throttle so a burst can't spam pushes (the hub enforces its own)

/**
 * Relays agent notifications over the already-open edge hub socket (`notify` frames) so the
 * user's hub can deliver them as encrypted web pushes — letting the user receive screen-change
 * alerts even when the controller PWA is closed. Cloud-mode only; best-effort: when the socket
 * is down there's no cloud presence either, so a dropped alert changes nothing the user could
 * have seen remotely anyway.
 */
export function startPushPublisher(
  hub: NotificationHub,
  edge: EdgeClient,
  deviceId?: string,
): PushPublisherHandle {
  let last = 0;
  const unsubscribe = hub.subscribe((n) => {
    if (SKIP_SOURCES.has(n.source)) return;
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return;
    last = now;
    const sent = edge.send({
      t: "notify",
      alert: {
        title: n.title,
        body: n.body ?? "",
        level: n.level,
        source: n.source,
        t: n.t,
        // Lets the push deep-link the notification click back to THIS machine on the
        // dashboard (a plain /app/ open has no #token+device and is a dead page).
        ...(deviceId ? { machine: deviceId } : {}),
      },
    });
    if (!sent) log.warn("push relay skipped: edge socket not connected");
  });
  log.info("cloud: push relay active — alerts also delivered as web push when the app is closed");
  return { stop: unsubscribe };
}
