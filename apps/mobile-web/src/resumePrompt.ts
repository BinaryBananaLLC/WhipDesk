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
export interface ResumeCopy {
  title: string;
  msg: string;
  action: string;
}

const DEFAULT_COPY: ResumeCopy = {
  title: "Welcome back! \u{1F44B}",
  msg: "Looks like you wandered off. Want to pick up right where you left off?",
  action: "Resume whipping",
};

export class ResumePrompt {
  private readonly overlay: HTMLElement;
  private readonly title: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly resume: HTMLButtonElement;
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

    this.title = document.createElement("h2");

    this.msg = document.createElement("p");
    this.msg.className = "wd-resume-msg";

    this.resume = document.createElement("button");
    this.resume.className = "wd-resume-go";
    this.resume.onclick = () => {
      this.hide();
      this.onResume?.();
    };

    card.append(whip, this.title, this.msg, this.resume);

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

  /**
   * Show the gate. `onResume` runs only if the user taps the action button (Back-to-dashboard
   * navigates away). Pass `copy` to reuse the gate for other terminal states — e.g. the
   * single-session takeover notice — instead of the default "you were away" wording.
   */
  show(onResume: () => void, copy: ResumeCopy = DEFAULT_COPY): void {
    this.title.textContent = copy.title;
    this.msg.textContent = copy.msg;
    this.resume.textContent = copy.action;
    this.onResume = onResume;
    this.overlay.classList.remove("hidden");
  }

  hide(): void {
    this.overlay.classList.add("hidden");
  }
}
