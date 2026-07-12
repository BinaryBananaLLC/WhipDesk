/* eslint-disable */
/**
 * WhipDesk web-push handler (service worker).
 *
 * Shows a notification for every incoming web push even when the controller PWA is closed.
 *
 * IMPORTANT: the `push` listener is registered SYNCHRONOUSLY at script evaluation and displays
 * the notification itself — a push that WAKES a cold service worker dispatches before any
 * late-registered handler exists, so anything async here would leave Chrome showing its generic
 * "This site has been updated in the background" fallback instead of the real alert.
 * Subscription registration lives page-side (src/push.ts); the worker only parses the payload
 * ({ notification: { title, body, ... }, data: { link } } — sent by the user's edge hub) and
 * renders it.
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
  // Where a click should go. The hub sends the dashboard (deep-linked to the machine) — NOT /app/,
  // which is a dead page without its #token+device. Carry it on the notification's `data` so
  // notificationclick can read it (this SW renders pushes itself, so nothing else preserves it).
  const link = d.link || "/dashboard/";
  const title = n.title || d.title || "WhipDesk";
  const body = n.body || d.body || "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // App open and visible => hand the payload to the page for its own in-app toast and skip
      // the OS notification (the page listens for these messages in src/push.ts).
      const visible = wins.filter((w) => w.visibilityState === "visible");
      if (visible.length > 0) {
        for (const w of visible) w.postMessage({ type: "wd-push", notification: { title, body }, data: { link } });
        return;
      }
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
  const link = (event.notification.data && event.notification.data.link) || "/dashboard/";
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
