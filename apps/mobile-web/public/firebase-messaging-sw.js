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
  const fcmOpts = payload.fcmOptions || payload.fcm_options || {};
  // Where a click should go. The Cloud Function sends the dashboard (deep-linked to the machine) —
  // NOT /app/, which is a dead page without its #token+device. Carry it on the notification's `data`
  // so notificationclick can read it (this SW renders pushes itself, so nothing else preserves it).
  const link = d.link || fcmOpts.link || "/en/dashboard/";
  const title = n.title || d.title || "WhipDesk";
  const body = n.body || d.body || "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // App open and visible => its own in-app alerts cover this; skip the OS notification
      // (same policy the FCM SDK applied).
      if (wins.some((w) => w.visibilityState === "visible")) return;
      // Icon + badge: unbranded (icon-less) notifications are the ones Chrome's on-device spam
      // model flags ("Chrome detected possible spam"). Always render with the app icon.
      return self.registration.showNotification(title, {
        body,
        icon: n.icon || d.icon || "./android-chrome-192x192.png",
        badge: "./android-chrome-192x192.png",
        tag: n.tag || d.tag || "whipdesk-alert",
        renotify: true,
        data: { link },
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/en/dashboard/";
  const target = new URL(link, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // Prefer an already-open WhipDesk tab: focus it (and navigate it to the target if it can) so
      // clicking doesn't spawn a duplicate window.
      for (const w of wins) {
        if (w.url && new URL(w.url).origin === target.origin && "focus" in w) {
          if ("navigate" in w && w.url !== target.href) {
            return w.navigate(target.href).then((c) => (c || w).focus()).catch(() => w.focus());
          }
          return w.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target.href);
    }),
  );
});
