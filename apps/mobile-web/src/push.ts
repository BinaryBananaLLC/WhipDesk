import type { Notifications } from "./notifications";
import type { FirebaseWebConfig } from "./remote";

/**
 * Firebase Cloud Messaging (FCM) registration for the REMOTE (whipdesk.com) controller, so
 * the user still gets screen-change alerts when this PWA is closed or backgrounded.
 *
 * Flow: register the messaging service worker → mint an FCM token (needs a Web Push VAPID key
 * in the firebase config) → store it under `users/{uid}/fcmTokens/{token}` so the cloud
 * sender can target this device. The desktop agent (cloud mode) writes alerts to
 * `users/{uid}/pushQueue`; a Cloud Function turns those into FCM web pushes — see
 * the web project's functions and the service worker firebase-messaging-sw.js.
 *
 * Entirely best-effort: without a VAPID key, denied permission, or no service-worker support
 * it simply no-ops, leaving the existing in-app / connected-tab notifications untouched.
 */
export async function registerPush(config: FirebaseWebConfig, notifications: Notifications): Promise<void> {
  if (!config.vapidKey) return; // not configured yet (generate one in the Firebase console)
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return;

  try {
    const { initializeApp, getApps } = await import("firebase/app");
    const { getAuth } = await import("firebase/auth");
    const { getFirestore, doc, setDoc, serverTimestamp } = await import("firebase/firestore");
    const { getMessaging, getToken, onMessage, isSupported } = await import("firebase/messaging");

    if (!(await isSupported().catch(() => false))) return;

    const app = getApps()[0] ?? initializeApp(config);
    const user = getAuth(app).currentUser;
    if (!user) return; // remote.ts already gates the page on the real signed-in user

    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") return;
    }
    if (Notification.permission !== "granted") return;

    const swReg = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: swReg,
    });
    if (!token) return;

    const db = getFirestore(app);
    await setDoc(
      doc(db, "users", user.uid, "fcmTokens", token),
      { token, ua: navigator.userAgent, updatedAt: serverTimestamp() },
      { merge: true },
    );

    // Foreground delivery: FCM does NOT auto-display while the page is focused, so mirror it
    // into our own toast + system notification path.
    onMessage(messaging, (payload) => {
      const n = payload.notification;
      notifications.show({
        type: "notification",
        id: `push-${Date.now()}`,
        title: n?.title ?? "WhipDesk",
        body: n?.body,
        level: "info",
        source: "push",
        t: Date.now(),
      });
    });
  } catch {
    /* push is best-effort; it must never break the controller */
  }
}
