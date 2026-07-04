/* eslint-disable */
/**
 * WhipDesk FCM background handler (service worker).
 *
 * Shows a notification for every incoming web push even when the controller PWA is closed.
 *
 * IMPORTANT: the `push` listener is registered SYNCHRONOUSLY at script evaluation and displays
 * the notification itself — no Firebase SDK. The previous version initialized the FCM compat SDK
 * asynchronously (after fetching ./firebase.json), but a push that WAKES a cold service worker
 * dispatches before any late-registered handler exists, so nothing called showNotification and
 * Chrome displayed its generic "This site has been updated in the background" fallback instead
 * of the real alert. Token registration lives page-side (src/push.ts); the worker only needs to
 * parse the FCM webpush payload ({ notification: { title, body, ... }, data: {...} }) and render
 * it, which needs no SDK at all.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    /* non-JSON push — fall through to the generic title below */
  }
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || "WhipDesk";
  const body = n.body || d.body || "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // App open and visible => its own in-app alerts cover this; skip the OS notification
      // (same policy the FCM SDK applied).
      if (wins.some((w) => w.visibilityState === "visible")) return;
      return self.registration.showNotification(title, {
        body,
        tag: n.tag || d.tag || "whipdesk-alert",
        renotify: true,
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) return w.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    }),
  );
});
