import type { PinRequest } from "./connection";
import { DONATE_URL, dashboardUrl } from "./site";
import { icon } from "./icons";
import whipMark from "./assets/whip.png";

/**
 * Full-screen modal that asks for the device PIN. The PIN is handed to a callback (the
 * connection computes the challenge response locally — it never travels as plaintext).
 */
export class PinPrompt {
  private readonly overlay: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly message: HTMLElement;
  private onSubmit: ((pin: string) => void) | null = null;

  constructor(root: HTMLElement) {
    this.overlay = document.createElement("div");
    this.overlay.className = "wd-pin-overlay hidden";

    const card = document.createElement("div");
    card.className = "wd-pin-card";

    const whip = document.createElement("img");
    whip.className = "wd-pin-whip";
    whip.src = whipMark;
    whip.alt = "WhipDesk";
    whip.decoding = "async";

    const title = document.createElement("h2");
    title.textContent = "Enter device PIN";

    this.message = document.createElement("p");
    this.message.className = "wd-pin-msg";
    this.message.textContent = "You're connected. Enter the PIN to unlock this device and start whipping.";

    this.input = document.createElement("input");
    this.input.className = "wd-pin-input";
    this.input.type = "password";
    this.input.inputMode = "numeric";
    // Keep the masking but stop Chrome/Safari offering to SAVE it: a device PIN is not an account
    // password. "one-time-code" marks it as an OTP, and the password-manager ignore hints cover
    // 1Password/LastPass.
    this.input.autocomplete = "one-time-code";
    this.input.name = "wd-device-pin";
    this.input.setAttribute("data-1p-ignore", "true");
    this.input.setAttribute("data-lpignore", "true");
    this.input.setAttribute("aria-label", "Device PIN");
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });

    const submitBtn = document.createElement("button");
    submitBtn.className = "wd-pin-submit";
    submitBtn.textContent = "Unlock";
    submitBtn.onclick = () => this.submit();

    // A small, contextual nudge to support the project — sits between Unlock and the back link.
    const support = document.createElement("button");
    support.type = "button";
    support.className = "wd-support-link wd-pin-support";
    support.append(icon("heart", 14));
    const supportLabel = document.createElement("span");
    supportLabel.textContent = "Support WhipDesk";
    support.append(supportLabel);
    support.onclick = () => window.open(DONATE_URL, "_blank", "noopener");

    // Escape hatch: leave this device and go back to the dashboard (locale-aware; relative when
    // already on whipdesk.com, absolute when served by the agent over LAN).
    const back = document.createElement("button");
    back.className = "wd-pin-back";
    back.textContent = "← Back to dashboard";
    back.onclick = () => {
      window.location.href = dashboardUrl();
    };

    card.append(whip, title, this.message, this.input, submitBtn, support, back);
    this.overlay.appendChild(card);
    root.appendChild(this.overlay);
  }

  show(req: PinRequest, onSubmit: (pin: string) => void): void {
    this.onSubmit = onSubmit;
    this.input.value = "";
    if (req.retry) {
      this.message.textContent =
        req.attemptsLeft > 0
          ? `Wrong PIN — ${req.attemptsLeft} attempt(s) left.`
          : "Wrong PIN. Try again.";
      this.message.classList.add("err");
      navigator.vibrate?.([40, 40, 40]);
    } else {
      this.message.textContent = "You're connected. Enter the PIN to unlock this device and start whipping.";
      this.message.classList.remove("err");
    }
    this.overlay.classList.remove("hidden");
    window.setTimeout(() => this.input.focus(), 50);
  }

  hide(): void {
    this.overlay.classList.add("hidden");
  }

  private submit(): void {
    const pin = this.input.value.trim();
    if (pin.length < 4) {
      this.message.textContent = "PIN is at least 4 characters.";
      this.message.classList.add("err");
      return;
    }
    this.onSubmit?.(pin);
    this.message.textContent = "Checking…";
    this.message.classList.remove("err");
  }
}
