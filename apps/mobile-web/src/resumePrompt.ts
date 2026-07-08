import { dashboardUrl } from "./site";
import whipMark from "./assets/whip.png";

/**
 * Friendly "you were away" gate shown before a mobile tab reconnects. A backgrounded controller tab
 * — or one Android Chrome discarded and silently reloaded — would otherwise re-run the entire
 * connect → ICE → TURN → PIN handshake the instant you glance back at it, burning a relay
 * allocation and dropping you on a PIN box you never asked for. Instead we ask first and do NOTHING
 * (no network, no ICE) until the user chooses: Resume kicks off the reconnect (→ PIN); Back to
 * dashboard leaves. Only used for remote (whipdesk.com) sessions; LAN reconnects are cheap.
 */
export class ResumePrompt {
  private readonly overlay: HTMLElement;
  private onResume: (() => void) | null = null;

  constructor(root: HTMLElement, opts?: { dashboardEscape?: boolean }) {
    this.overlay = document.createElement("div");
    this.overlay.className = "wd-resume hidden";

    const card = document.createElement("div");
    card.className = "wd-resume-card";

    const whip = document.createElement("img");
    whip.className = "wd-resume-whip";
    whip.src = whipMark;
    whip.alt = "WhipDesk";
    whip.decoding = "async";

    const title = document.createElement("h2");
    title.textContent = "Welcome back! \u{1F44B}";

    const msg = document.createElement("p");
    msg.className = "wd-resume-msg";
    msg.textContent = "Looks like you wandered off. Want to pick up right where you left off?";

    const resume = document.createElement("button");
    resume.className = "wd-resume-go";
    resume.textContent = "Resume whipping";
    resume.onclick = () => {
      this.hide();
      this.onResume?.();
    };

    card.append(whip, title, msg, resume);

    if (opts?.dashboardEscape) {
      // Same quiet text-link treatment as the PIN dialog's back link.
      const back = document.createElement("button");
      back.type = "button";
      back.className = "wd-pin-back wd-resume-back";
      back.textContent = "\u2190 Back to dashboard";
      back.onclick = () => {
        window.location.href = dashboardUrl();
      };
      card.append(back);
    }

    this.overlay.appendChild(card);
    root.appendChild(this.overlay);
  }

  get visible(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  /** Show the gate. `onResume` runs only if the user taps Resume (Back-to-dashboard navigates away). */
  show(onResume: () => void): void {
    this.onResume = onResume;
    this.overlay.classList.remove("hidden");
  }

  hide(): void {
    this.overlay.classList.add("hidden");
  }
}
