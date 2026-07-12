import { edgeFetch } from "./cloudApi";
import type { Notifications } from "./notifications";
import type { FirebaseWebConfig } from "./remote";

/**
 * Web-push registration for the REMOTE (whipdesk.com) controller, so the user still gets
 * screen-change alerts when this PWA is closed or backgrounded.
 *
 * Flow: register the push service worker → subscribe this browser with the standard Push API
 * (`pushManager.subscribe` against the VAPID public key from the config) → store the subscription
 * on the backend (POST /v1/push/subscribe) so the sender can target this device. The desktop
 * agent (cloud mode) relays alerts over its edge socket; the backend encrypts and fans them out
 * to every registered browser — rendered by the service worker (public/push-sw.js).
 *
 * Entirely best-effort: without a VAPID key, denied permission, or no service-worker support it
 * simply no-ops, leaving the existing in-app / connected-tab notifications untouched.
 */
export async function registerPush(config: FirebaseWebConfig, notifications: Notifications): Promise<void> {
  if (!config.vapidKey) return; // not configured (any standard VAPID key pair works)
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) return;

  try {
    const { initializeApp, getApps } = await import("firebase/app");
    const { getAuth } = await import("firebase/auth");
    const app = getApps()[0] ?? initializeApp(config);
    const user = getAuth(app).currentUser;
    if (!user) return; // remote.ts already gates the page on the real signed-in user

    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") return;
    }
    if (Notification.permission !== "granted") return;

    const swReg = await navigator.serviceWorker.register("./push-sw.js");
    const sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidKey) as BufferSource,
    });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

    await edgeFetch(config, user, "/v1/push/subscribe", {
      body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, ua: navigator.userAgent },
    });

    // Foreground delivery: the service worker skips the OS notification while the app is visible
    // and hands the payload here instead — mirror it into our own toast path.
    navigator.serviceWorker.addEventListener("message", (event) => {
      const payload = (event as MessageEvent).data as {
        type?: string;
        notification?: { title?: string; body?: string };
      } | null;
      if (!payload || payload.type !== "wd-push") return;
      notifications.show({
        type: "notification",
        id: `push-${Date.now()}`,
        title: payload.notification?.title ?? "WhipDesk",
        body: payload.notification?.body,
        level: "info",
        source: "push",
        t: Date.now(),
      });
    });
  } catch {
    /* push is best-effort; it must never break the controller */
  }
}

/** Standard base64url → bytes for `applicationServerKey` (the Push API wants raw bytes). */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
