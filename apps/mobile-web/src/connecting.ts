import whipMark from "./assets/whip.png";

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

export class ConnectingOverlay {
  private readonly overlay: HTMLElement;
  private readonly msg: HTMLElement;
  private rotateTimer = 0;
  private msgIndex = 0;

  constructor(root: HTMLElement) {
    this.overlay = document.createElement("div");
    this.overlay.className = "wd-connecting hidden";

    const card = document.createElement("div");
    card.className = "wd-connecting-card";

    const whip = document.createElement("img");
    whip.className = "wd-connecting-whip";
    whip.src = whipMark;
    whip.alt = "WhipDesk";
    whip.decoding = "async";

    const spinner = document.createElement("div");
    spinner.className = "wd-connecting-spinner";

    this.msg = document.createElement("p");
    this.msg.className = "wd-connecting-msg";
    this.msg.textContent = MESSAGES[0]!;

    card.append(whip, spinner, this.msg);
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
  }
}
