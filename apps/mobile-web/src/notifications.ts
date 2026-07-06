import type { NotificationLevel, NotificationMessage } from "@whipdesk/protocol";

/** Level → leading glyph for the in-app toast (SVG paths, so they inherit the accent color). */
const GLYPHS: Record<NotificationLevel, string> = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  warning: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  error: '<path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

/** How long a toast stays before auto-dismiss, by level. Errors never auto-dismiss. */
const TTL_MS: Record<NotificationLevel, number> = {
  success: 3500,
  info: 5000,
  warning: 8000,
  error: 0, // sticky — the user dismisses it
};

/** At most this many toasts on screen; a burst evicts the oldest so it can't cover the app. */
const MAX_TOASTS = 4;

/**
 * Shows incoming notifications as an in-app toast and, when permitted, a system Web
 * Notification. Background push for a closed PWA is handled separately in push.ts.
 *
 * Toasts are dismissible (× or tap), pause their auto-dismiss while hovered/held so they can be
 * read, and carry a level glyph + accent. Errors are sticky (they matter most and are the ones a
 * 5s timeout used to steal off-screen). System notifications focus the app on click and, for
 * errors, stay up until acted on (requireInteraction).
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
        // Icon + badge: icon-less notifications are what Chrome's spam heuristic flags — keep it
        // branded. Errors use requireInteraction so an important alert doesn't auto-vanish, and a
        // click focuses the app instead of doing nothing.
        const sys = new Notification(n.title, {
          body: n.body,
          tag: n.id,
          icon: "./android-chrome-192x192.png",
          badge: "./android-chrome-192x192.png",
          timestamp: n.t || Date.now(),
          renotify: true,
          requireInteraction: n.level === "error",
        } as NotificationOptions);
        sys.onclick = () => {
          try {
            window.focus();
          } catch {
            /* ignore */
          }
          sys.close();
        };
      }
    } catch {
      /* ignore */
    }
    navigator.vibrate?.(n.level === "error" ? [60, 40, 60] : 40);
  }

  private toast(n: NotificationMessage): void {
    // Cap the stack: drop the oldest so a flurry of alerts can never wall off the screen.
    while (this.container.childElementCount >= MAX_TOASTS && this.container.firstElementChild) {
      this.container.firstElementChild.remove();
    }

    const el = document.createElement("div");
    el.className = `wd-toast wd-${n.level}`;
    el.setAttribute("role", n.level === "error" || n.level === "warning" ? "alert" : "status");

    const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glyph.setAttribute("class", "wd-toast-glyph");
    glyph.setAttribute("viewBox", "0 0 24 24");
    glyph.setAttribute("fill", "none");
    glyph.setAttribute("stroke", "currentColor");
    glyph.setAttribute("stroke-width", "2");
    glyph.setAttribute("stroke-linecap", "round");
    glyph.setAttribute("stroke-linejoin", "round");
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML = GLYPHS[n.level] ?? GLYPHS.info;

    const content = document.createElement("div");
    content.className = "wd-toast-content";
    const title = document.createElement("strong");
    title.textContent = n.title; // textContent: never interpolate untrusted strings as HTML
    content.appendChild(title);
    if (n.body) {
      const body = document.createElement("span");
      body.textContent = n.body;
      content.appendChild(body);
    }

    const close = document.createElement("button");
    close.className = "wd-toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>';

    el.append(glyph, content, close);
    this.container.appendChild(el);

    const dismiss = () => {
      if (!el.isConnected) return;
      el.classList.add("wd-hide");
      window.setTimeout(() => el.remove(), 300);
    };
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
    });
    // Tapping the toast body dismisses it too (mobile: no easy hover to find the ×).
    el.addEventListener("click", dismiss);

    // Auto-dismiss with a hover/press pause, so an alert can't slide away while it's being read.
    const ttl = TTL_MS[n.level] ?? TTL_MS.info;
    if (ttl > 0) {
      let timer = window.setTimeout(dismiss, ttl);
      const pause = () => window.clearTimeout(timer);
      const resume = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(dismiss, 1500);
      };
      el.addEventListener("pointerenter", pause);
      el.addEventListener("pointerleave", resume);
    }
  }
}
