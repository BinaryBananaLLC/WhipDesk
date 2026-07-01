/* eslint-disable */
/**
 * WhipDesk FCM background handler (service worker).
 *
 * Receives Firebase Cloud Messaging web pushes and shows a notification even when the
 * controller PWA is closed. Uses the compat SDK via importScripts (the modular SDK can't run
 * in a classic service worker) and reads the public-safe web config emitted next to this file
 * by scripts/sync-controller.cjs (firebase.json). See apps/mobile-web/src/push.ts.
 */
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

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

(async () => {
  try {
    const res = await fetch("./firebase.json", { cache: "no-store" });
    if (!res.ok) return;
    const config = await res.json();
    firebase.initializeApp(config);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage((payload) => {
      const n = (payload && payload.notification) || {};
      self.registration.showNotification(n.title || "WhipDesk", {
        body: n.body || "",
        tag: (payload && payload.data && payload.data.tag) || "whipdesk-alert",
        renotify: true,
      });
    });
  } catch (e) {
    /* no config / unsupported browser — background push stays disabled */
  }
})();
