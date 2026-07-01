import type { NotificationLevel, NotificationMessage } from "@whipdesk/protocol";

/**
 * Shows incoming notifications as an in-app toast and, when permitted, a system Web
 * Notification. Background push for a closed PWA is handled separately in push.ts.
 */
export class Notifications {
  constructor(private readonly container: HTMLElement) {}

  async requestPermission(): Promise<void> {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
    } catch {
      /* unsupported */
    }
  }

  get permission(): NotificationPermission | "unsupported" {
    return "Notification" in window ? Notification.permission : "unsupported";
  }

  /** Lightweight in-app-only toast (no system notification) for local UI confirmations. */
  flash(title: string, body?: string, level: NotificationLevel = "info"): void {
    this.toast({
      type: "notification",
      id: `flash-${Date.now()}`,
      title,
      body,
      level,
      source: "client",
      t: Date.now(),
    });
  }

  show(n: NotificationMessage): void {
    this.toast(n);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(n.title, { body: n.body, tag: n.id });
      }
    } catch {
      /* ignore */
    }
    navigator.vibrate?.(n.level === "error" ? [60, 40, 60] : 40);
  }

  private toast(n: NotificationMessage): void {
    const el = document.createElement("div");
    el.className = `wd-toast wd-${n.level}`;

    const title = document.createElement("strong");
    title.textContent = n.title; // textContent: never interpolate untrusted strings as HTML
    el.appendChild(title);

    if (n.body) {
      const body = document.createElement("span");
      body.textContent = n.body;
      el.appendChild(body);
    }

    this.container.appendChild(el);
    window.setTimeout(() => {
      el.classList.add("wd-hide");
      window.setTimeout(() => el.remove(), 300);
    }, 5000);
  }
}
