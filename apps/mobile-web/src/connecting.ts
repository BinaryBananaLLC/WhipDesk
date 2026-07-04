import loadingAnim from "./assets/loading-whip-anim.gif";
import { dashboardUrl } from "./site";

/**
 * Full-screen "connecting…" overlay shown during the initial handshake — before the PIN prompt
 * or the first frame. The WebRTC path can take a few seconds (signaling round-trip, ICE, and a
 * relay fallback on isolated networks like hotel Wi-Fi), so this gives the user something alive
 * to look at. It only shows for the FIRST connect; later in-session reconnects are silent (the
 * status pill covers those) to avoid flicker.
 */
const MESSAGES = [
  "Rounding up your AI agents…",
  "Connecting to your agent farm…",
  "Uncoiling the whip…",
  "Negotiating the fastest route…",
  "Tightening the leash…",
  "Almost in the saddle…",
];

/** How long the overlay must sit on screen before the escape hatch fades in. Quick, healthy
 * connects never see it; only a slow/stuck handshake earns an exit. */
const ESCAPE_DELAY_MS = 3000;

export class ConnectingOverlay {
  private readonly overlay: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly back: HTMLButtonElement | null = null;
  private rotateTimer = 0;
  private msgIndex = 0;
  private escapeTimer = 0;

  /**
   * `dashboardEscape` adds a quiet "← Back to dashboard" link that fades in after a few seconds —
   * the exit for "it's taking too long / I picked the wrong machine". Cloud (whipdesk.com) only:
   * on a LAN-served controller there is no dashboard of machines to go back to, so the link would
   * just strand the user on the marketing site.
   */
  constructor(root: HTMLElement, opts?: { dashboardEscape?: boolean }) {
    this.overlay = document.createElement("div");
    this.overlay.className = "wd-connecting hidden";

    const card = document.createElement("div");
    card.className = "wd-connecting-card";

    // The animated whip gif IS the loading animation (replaces the CSS-swung static icon and the
    // spinner). Its frames sit on a black canvas, so the overlay behind it is pure black to match.
    const whip = document.createElement("img");
    whip.className = "wd-connecting-anim";
    whip.src = loadingAnim;
    whip.alt = "WhipDesk";
    whip.decoding = "async";

    this.msg = document.createElement("p");
    this.msg.className = "wd-connecting-msg";
    this.msg.textContent = MESSAGES[0]!;

    card.append(whip, this.msg);

    if (opts?.dashboardEscape) {
      // Same quiet text-link treatment as the PIN dialog's back link — deliberately NOT a primary
      // button: connecting usually succeeds, so the escape hatch must never compete with the wait.
      this.back = document.createElement("button");
      this.back.type = "button";
      this.back.className = "wd-pin-back wd-connecting-back";
      this.back.textContent = "← Back to dashboard";
      this.back.onclick = () => {
        window.location.href = dashboardUrl();
      };
      card.append(this.back);
    }

    this.overlay.appendChild(card);
    root.appendChild(this.overlay);
  }

  /**
   * Show the overlay. With no argument it rotates the playful first-connect messages; pass a fixed
   * string (e.g. "Reconnecting…") for a resume, where a steady, honest label beats cutesy rotation.
   */
  show(fixedMessage?: string): void {
    this.msg.textContent = fixedMessage ?? MESSAGES[this.msgIndex]!;
    if (!this.overlay.classList.contains("hidden")) return; // already visible; text updated above
    this.overlay.classList.remove("hidden");
    if (this.back && !this.escapeTimer) {
      this.escapeTimer = window.setTimeout(() => this.back!.classList.add("shown"), ESCAPE_DELAY_MS);
    }
    if (fixedMessage) return; // steady message → no rotation
    this.rotateTimer = window.setInterval(() => {
      this.msgIndex = (this.msgIndex + 1) % MESSAGES.length;
      this.msg.textContent = MESSAGES[this.msgIndex]!;
    }, 2200);
  }

  hide(): void {
    this.overlay.classList.add("hidden");
    window.clearInterval(this.rotateTimer);
    this.rotateTimer = 0;
    window.clearTimeout(this.escapeTimer);
    this.escapeTimer = 0;
    this.back?.classList.remove("shown");
  }
}
