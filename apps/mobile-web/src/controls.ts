import {
  CLIPBOARD_MAX_TEXT,
  type DisplayInfo,
  type NotificationLevel,
  type WelcomeMessage,
} from "@whipdesk/protocol";
import type { ConnectionStatus, ControllerTransport } from "./core";
import type { InputController } from "./input";
import type { Notifications } from "./notifications";
import type { ScreenView } from "./screen";
import type { RegionWatchers } from "./watchers";
import type { Whipository } from "./whipository";
import { icon, type IconName } from "./icons";
import { PromptHistory } from "./promptHistory";
import { DONATE_URL, GITHUB_URL, REDDIT_URL, dashboardUrl } from "./site";
import whipositoryMark from "./assets/whipository.png";
import autoWhipsIcon from "./assets/auto-whips-icon.png";

interface Deps {
  conn: ControllerTransport;
  view: ScreenView;
  input: InputController;
  notifications: Notifications;
  watchers: RegionWatchers;
  whipository: Whipository;
}

type Tab = "viewer" | "interact" | "type" | "monitor";

/** Handles into an open clipboard fallback dialog (see openClipDialog). */
interface ClipDialog {
  ta: HTMLTextAreaElement;
  action: HTMLButtonElement;
  close: () => void;
}

const SPECIAL_KEYS: Array<[string, string]> = [
  ["Esc", "Escape"],
  ["Tab", "Tab"],
  ["⌫", "Backspace"],
  ["⏎", "Enter"],
  ["←", "ArrowLeft"],
  ["↑", "ArrowUp"],
  ["↓", "ArrowDown"],
  ["→", "ArrowRight"],
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A labeled group of controls that wraps to save space (e.g. "Zoom" with + / −). */
function group(label: string, ...children: HTMLElement[]): HTMLElement {
  const g = el("div", "wd-group");
  g.appendChild(el("span", "wd-group-label", label));
  const inner = el("div", "wd-group-items");
  inner.append(...children);
  g.appendChild(inner);
  return g;
}

/** A button that repeats its action while held down (press-and-hold). */
function holdBtn(b: HTMLButtonElement, action: () => void): HTMLButtonElement {
  let timer = 0;
  let interval = 0;
  const stop = () => {
    window.clearTimeout(timer);
    window.clearInterval(interval);
  };
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    action();
    timer = window.setTimeout(() => {
      interval = window.setInterval(action, 80);
    }, 350);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    b.addEventListener(ev, stop);
  }
  return b;
}

function btn(label: string, className = "wd-btn"): HTMLButtonElement {
  return el("button", className, label);
}

/** Button with a leading SVG icon and optional text label. */
function iconBtn(name: IconName, label = "", className = "wd-btn"): HTMLButtonElement {
  const b = el("button", className);
  b.appendChild(icon(name));
  if (label) {
    const span = el("span", "wd-btn-label", label);
    b.appendChild(span);
  } else {
    b.classList.add("wd-icon-only");
    b.setAttribute("aria-label", name);
  }
  return b;
}

/** Square, icon-only button using the Whipository mark (raster art, so it's an <img>, not an SVG
 * from the icon set). Used next to any prompt box that a whip can be inserted into. */
function whipButton(onClick: () => void): HTMLButtonElement {
  const b = el("button", "wd-btn wd-icon-only wd-whips-btn");
  const img = document.createElement("img");
  img.src = whipositoryMark;
  img.alt = "";
  img.decoding = "async";
  b.appendChild(img);
  b.title = "Whipository — insert a saved prompt";
  b.setAttribute("aria-label", "Insert a saved prompt");
  b.onclick = onClick;
  return b;
}

/** An icon + label anchor that opens an external page (Reddit/GitHub) safely in a new tab. */
function feedbackLink(name: IconName, label: string, href: string): HTMLAnchorElement {
  const a = el("a", "wd-conn-feedback-link");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.append(icon(name, 16), el("span", undefined, label));
  return a;
}

/** One-line explanation of the active transport, for the connection dialog. */
function transportDesc(t: string): string {
  switch (t.toUpperCase()) {
    case "LAN":
      return "Direct on your local network — fastest, no relay.";
    case "STUN":
      return "Direct peer-to-peer across networks.";
    case "TURN":
      return "Your network blocked a direct P2P connection, so we're bouncing your stream through our encrypted relay. Yes, this costs us actual money to run. Consider supporting us.";
    default:
      return "";
  }
}

/**
 * Display text for a transport badge. TURN gets a leading "$" ("$ TURN") because relay traffic is
 * the one route that costs us real money — a quick visual cue in the status pill + dialog.
 */
function transportLabel(t: string): string {
  return t.toUpperCase() === "TURN" ? `$ ${t}` : t;
}

/**
 * The mobile UI: a top status bar + a collapsible bottom ribbon with one tab per task.
 * Only the active tab's controls are shown, so buttons never stack or overlap.
 *
 *  - Browse:   zoom −/+, pan, scroll/page; tap the screen to click, just like the real device.
 *  - Type:     write text — textarea + special keys + Insert (no Enter) / Send (Enter).
 *  - Interact: full control — Mouse|Touch|Shortcuts segment. Mouse: Left, Left-held (latched
 *    button-down for dragging/resizing host windows), Right, Double, Link (modifier-click that
 *    opens the link under the cursor). Shortcuts: Copy (host
 *    selection → this device), Paste (this device → host), Select all, Undo, Redo, Save, Apps
 *    (hold-open ⌘-Tab/Alt+Tab app switcher driven by a floating Tab/Switch pill) and Window
 *    (same-app window cycle, hidden on Windows hosts) — with Ctrl/⌘ C/V/A/Z/S forwarded on
 *    desktop controllers (see onGlobalKey/onGlobalPaste).
 *  - Monitor:  pick which display to view + control.
 *
 * A chevron collapses the whole ribbon to a slim handle to free the screen.
 */
export class Controls {
  private readonly statusDot = el("span", "wd-dot");
  private readonly statusText = el("span", "wd-status-text", "Connecting…");
  private readonly transportBadge = el("span", "wd-transport hidden");
  private readonly alertBadge = el("span", "wd-badge hidden");
  private statusbar!: HTMLElement;
  private statusCollapseTimer = 0;
  private connectionOverlay!: HTMLElement;
  private connName!: HTMLElement;
  private connRoute!: HTMLElement;
  private connSpeed!: HTMLElement;
  private connStatusDot!: HTMLElement;
  private connStatusText!: HTMLElement;
  private connError!: HTMLElement;
  private connHdr!: HTMLElement;
  private hostHdr = false;
  private lastError = "";
  private netFps = 0;
  private netRtt: number | null = null;

  private panel!: HTMLElement;
  private optionsArea!: HTMLElement;
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly tabPanes = new Map<Tab, HTMLElement>();
  private collapseBtn!: HTMLButtonElement;
  private hideRibbonBtn!: HTMLButtonElement;
  private ribbon!: HTMLElement;
  private fullscreenBtn: HTMLButtonElement | null = null;
  private interactHost!: HTMLElement;

  private monitorList!: HTMLElement;
  private promptInput!: HTMLTextAreaElement;
  // Task 3: terminal-style recall of the last few sent prompts. `histIndex` walks the list; -1 means
  // "editing / not navigating", indices 0..len-1 select a recalled entry, and `histDraft` preserves
  // whatever was being composed before you started walking back up.
  private readonly typeHistory = new PromptHistory();
  private histIndex = -1;
  private histDraft = "";
  private histPrevBtn: HTMLButtonElement | null = null;
  private histNextBtn: HTMLButtonElement | null = null;
  // Task 1: "Hold left" button (latched left-button-down for dragging/resizing host windows) plus a
  // persistent pill so the held state is obvious even if the ribbon is collapsed.
  private holdLeftBtn: HTMLButtonElement | null = null;
  private holdPill!: HTMLButtonElement;
  // App-switcher hold session (Shortcuts): the host's switcher modifier (⌘ on macOS, Alt
  // elsewhere) stays HELD so its overlay stays open; the floating pill's Tab/Switch buttons
  // cycle and commit. Mirrors the left-hold latch UX above.
  private appSwitchActive = false;
  private appSwitchMod = "alt"; // captured at start so the release always matches the press
  private appSwitchBtn: HTMLButtonElement | null = null;
  private switchPill!: HTMLElement;
  private switchPillText!: HTMLElement;
  private switchPillHint!: HTMLElement;

  private activeTab: Tab | null = null;
  private interactMode: "mouse" | "touch" | "shortcuts" = "mouse";
  // Host clipboard bridge (Interact → Shortcuts segment + desktop Ctrl/⌘ shortcuts). Platform picks
  // the Select-all/Undo/Redo chords; the capability gates Copy/Paste (older agents ignore those).
  private hostPlatform = "";
  private clipboardCap = false;
  private copyBtn: HTMLButtonElement | null = null;
  private copyPending = false;
  private copyTimeout = 0;
  private clipOverlay: HTMLElement | null = null;
  // Safari bridge: clipboard writes must START inside the user's tap, but the host's text arrives
  // later — so the tap hands the browser a ClipboardItem wrapping a PROMISE, resolved when the
  // clipboard-content reply lands (see armGestureCopy/handleClipboardContent).
  private pendingCopyResolve: ((blob: Blob) => void) | null = null;
  private pendingCopyReject: (() => void) | null = null;
  private copyWriteAttempt: Promise<boolean> | null = null;
  private collapsed = false;
  private ribbonHidden = false;
  private deviceName = "";
  private transport = "";
  private status: ConnectionStatus = "connecting";
  private displays: DisplayInfo[] = [];
  private activeDisplay = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: Deps,
  ) {
    this.build();
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusDot.dataset.status = status;
    if (status === "connected") this.lastError = ""; // a fresh connection supersedes a stale error
    // A dropped link ends the switcher session UI; the agent releases the held key itself.
    if (status !== "connected") this.endAppSwitch(false);
    this.renderStatusText();
    this.updateStatusCollapse();
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderConnection();
  }

  /** Badge on the top-right alerts bell showing how many region alerts are active. */
  setAlertCount(count: number): void {
    this.alertBadge.textContent = count > 0 ? String(count) : "";
    this.alertBadge.classList.toggle("hidden", count <= 0);
  }

  /** Show how the screen is reaching this device: LAN, Direct (P2P), STUN, or TURN (relay). */
  setTransport(label: string): void {
    this.transport = label;
    this.transportBadge.textContent = transportLabel(label);
    this.transportBadge.dataset.kind = label.toLowerCase();
    this.transportBadge.classList.toggle("hidden", !label);
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderConnection();
    this.peekStatus();
  }

  // The status pill auto-collapses to just its dot a few seconds after connecting (to free
  // the screen); tapping it reveals the full text again briefly, then it re-collapses.
  private updateStatusCollapse(): void {
    window.clearTimeout(this.statusCollapseTimer);
    if (this.status === "connected") {
      this.scheduleStatusCollapse();
    } else {
      this.statusbar?.classList.remove("collapsed");
    }
  }
  private scheduleStatusCollapse(): void {
    window.clearTimeout(this.statusCollapseTimer);
    this.statusCollapseTimer = window.setTimeout(() => {
      if (this.status === "connected") this.statusbar?.classList.add("collapsed");
    }, 4000);
  }
  private peekStatus(): void {
    this.statusbar?.classList.remove("collapsed");
    this.scheduleStatusCollapse();
  }

  private renderStatusText(): void {
    this.statusText.textContent =
      this.status === "connected"
        ? this.deviceName
          ? `Connected to ${this.deviceName}`
          : "Connected"
        : this.status === "connecting"
          ? "Connecting…"
          : "Disconnected";
  }

  setWelcome(w: WelcomeMessage): void {
    this.deviceName = w.agent.hostname;
    this.hostHdr = !!w.agent.hdr;
    this.hostPlatform = w.agent.platform;
    this.clipboardCap = !!w.capabilities.clipboard;
    this.renderStatusText();
    this.displays = w.displays ?? [];
    this.activeDisplay = w.activeDisplay ?? 0;
    this.renderMonitors();
    if (this.interactHost) this.renderInteract(); // clipboard support is now known
    if (!w.capabilities.mouse) {
      this.deps.notifications.show({
        type: "notification",
        id: `cap-${Date.now()}`,
        title: "View-only",
        body: "Mouse control isn't available — the host input module failed to load. Run `whipdesk --verbose` on the host for details.",
        level: "warning",
        source: "client",
        t: Date.now(),
      });
    }
  }

  setActiveDisplay(id: number): void {
    this.activeDisplay = id;
    this.renderMonitors();
    this.updateSwitchPillHint(); // reaching the main monitor (any way) retires the switcher hint
  }

  /** Switch which host monitor is captured — shared by the Monitors picker and the switcher hint. */
  private selectDisplay(id: number): void {
    this.deps.conn.send({ type: "select-display", id });
    this.activeDisplay = id;
    this.renderMonitors();
    this.updateSwitchPillHint();
  }

  // ---- connection dialog (opened by tapping the status pill) ----------------
  private buildConnectionDialog(): void {
    const overlay = el("div", "wd-dialog-overlay hidden");
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    head.append(el("h2", "", "Connection"));
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = () => overlay.classList.add("hidden");
    head.appendChild(x);

    const statusRow = el("div", "wd-conn-row");
    statusRow.append(el("span", "wd-conn-label", "Status"));
    const statusVal = el("div", "wd-conn-status");
    this.connStatusDot = el("span", "wd-dot");
    this.connStatusText = el("span", "wd-conn-value", "—");
    statusVal.append(this.connStatusDot, this.connStatusText);
    statusRow.appendChild(statusVal);

    // Machine row: name + a small pencil to rename it. The new name is persisted BY THE AGENT
    // (its state dir), so it sticks across restarts and shows up everywhere — status pill,
    // dashboard card, this dialog — not just in this browser.
    const nameRow = el("div", "wd-conn-row");
    nameRow.append(el("span", "wd-conn-label", "Machine"));
    this.connName = el("span", "wd-conn-value", "—");
    const nameWrap = el("div", "wd-conn-name");
    const editName = el("button", "wd-conn-edit");
    editName.appendChild(icon("pencil", 14));
    editName.title = "Rename this machine";
    editName.setAttribute("aria-label", "Rename this machine");
    editName.onclick = () => this.beginRenameMachine(nameWrap, editName);
    nameWrap.append(this.connName, editName);
    nameRow.appendChild(nameWrap);

    // Heads-up when the HOST desktop runs in HDR: the agent tone-maps the stream to SDR, but it
    // can still look washed compared to the real screen — say so here instead of looking broken.
    this.connHdr = el("div", "wd-conn-hdr hidden");
    this.connHdr.textContent =
      "HDR monitor detected — the image may look washed out. Turn HDR off on that machine if you see issues.";

    const routeRow = el("div", "wd-conn-row");
    routeRow.append(el("span", "wd-conn-label", "Connection"));
    this.connRoute = el("div", "wd-conn-route");
    routeRow.appendChild(this.connRoute);

    const speedRow = el("div", "wd-conn-row");
    speedRow.append(el("span", "wd-conn-label", "Speed (FPS/latency)"));
    this.connSpeed = el("span", "wd-conn-value", "—");
    speedRow.appendChild(this.connSpeed);

    this.connError = el("div", "wd-conn-error hidden");

    const disconnect = el("button", "wd-btn wd-disconnect");
    disconnect.append(icon("power"), el("span", "wd-btn-label", "Disconnect"));
    disconnect.onclick = () => this.disconnect();

    // Donate/support: ALWAYS visible in this dialog (it used to appear only on TURN sessions —
    // relay users are the costly ones, but everyone should be able to find the button).
    const support = el("div", "wd-conn-support");
    const donate = el("button", "wd-support-link");
    donate.append(icon("heart", 14), el("span", undefined, "Support WhipDesk"));
    donate.onclick = () => window.open(DONATE_URL, "_blank", "noopener");
    support.appendChild(donate);

    // Found a bug or have an idea? This dialog is where engaged users land, so it's a natural place
    // to invite reports and point them at the community/repo. Kept to a single line + two buttons so
    // it stays compact and translates cleanly (no idioms).
    const feedback = el("div", "wd-conn-feedback");
    feedback.append(el("p", "wd-conn-feedback-text", "Noticed an issue or have an idea? Reach out:"));
    const links = el("div", "wd-conn-feedback-links");
    links.append(
      feedbackLink("reddit", "Reddit", REDDIT_URL),
      feedbackLink("github", "GitHub", GITHUB_URL),
    );
    feedback.appendChild(links);

    // Row order: Status, Connection, Speed, Machine (+HDR note).
    card.append(head, statusRow, routeRow, speedRow, nameRow, this.connHdr, this.connError, disconnect, support, feedback);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
    this.connectionOverlay = overlay;
  }

  private renderConnection(): void {
    this.connStatusDot.dataset.status = this.status;
    this.connStatusText.textContent =
      this.status === "connected" ? "Connected" : this.status === "connecting" ? "Connecting…" : "Disconnected";
    if (this.lastError) {
      this.connError.textContent = this.lastError;
      this.connError.classList.remove("hidden");
    } else {
      this.connError.classList.add("hidden");
    }
    this.connName.textContent = this.deviceName || "Connected device";
    this.connHdr.classList.toggle("hidden", !this.hostHdr);
    this.connRoute.replaceChildren();
    if (this.transport) {
      const badge = el("span", "wd-transport");
      badge.textContent = transportLabel(this.transport);
      badge.dataset.kind = this.transport.toLowerCase();
      this.connRoute.append(badge, el("span", "wd-conn-desc", transportDesc(this.transport)));
      // The donate button lives in the dialog footer (always visible, every transport) — the TURN
      // description's "Consider supporting us" points at it.
    } else {
      this.connRoute.append(el("span", "wd-conn-desc", this.status === "connected" ? "Detecting route…" : "Connecting…"));
    }
    this.renderSpeed();
  }

  private renderSpeed(): void {
    const fps = `${this.netFps} FPS`;
    this.connSpeed.textContent = this.netRtt != null ? `${fps} / ${this.netRtt} ms` : fps;
  }

  /** Live link quality (rendered fps + round-trip ms), surfaced in the connection dialog. */
  setNetStats(fps: number, rtt: number | null): void {
    this.netFps = fps;
    this.netRtt = rtt;
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderSpeed();
  }

  /** Swap the Machine row's value into an inline editor (input + save). Enter saves, Esc cancels. */
  private beginRenameMachine(wrap: HTMLElement, editBtn: HTMLButtonElement): void {
    const input = el("input", "wd-conn-name-input");
    input.type = "text";
    input.maxLength = 64;
    input.value = this.deviceName;
    input.placeholder = "Machine name";
    const done = () => wrap.replaceChildren(this.connName, editBtn);
    const save = el("button", "wd-conn-edit");
    save.appendChild(icon("check", 14));
    save.title = "Save name";
    save.setAttribute("aria-label", "Save name");
    const commit = () => {
      const name = input.value.trim().slice(0, 64);
      done();
      if (!name || name === this.deviceName) return;
      // Optimistic update; the agent persists the name and echoes a machine-name broadcast so
      // every other connected controller updates too.
      this.deps.conn.send({ type: "rename-machine", name });
      this.setDeviceName(name);
    };
    save.onclick = commit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") done();
    };
    wrap.replaceChildren(input, save);
    input.focus();
    input.select();
  }

  /** Update the machine's display name everywhere (status pill + connection dialog). */
  setDeviceName(name: string): void {
    if (!name || name === this.deviceName) return;
    this.deviceName = name;
    this.renderStatusText();
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderConnection();
  }

  private openConnection(): void {
    this.renderConnection();
    this.connectionOverlay.classList.remove("hidden");
  }

  /** End the session and return to the dashboard (the new flow opens the controller in-tab). */
  private disconnect(): void {
    this.deps.conn.close();
    window.location.href = dashboardUrl();
  }

  flashError(message: string): void {
    this.lastError = message;
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderConnection();
    this.deps.notifications.show({
      type: "notification",
      id: `err-${Date.now()}`,
      title: "WhipDesk",
      body: message,
      level: "warning",
      source: "client",
      t: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  private build(): void {
    // --- top bar: a status pill (left, auto-collapsing) + the notifications bell (top-right) ---
    // No brand mark here — it read oddly next to the status dot. The whip lives on the PIN
    // prompt instead (see pinPrompt.ts).
    const status = el("div", "wd-statusbar");
    status.append(this.statusDot, this.statusText, this.transportBadge);
    status.onclick = () => this.openConnection();
    this.statusbar = status;
    this.buildConnectionDialog();

    // Auto-Whips button: the Auto-Whips mark, not a notification bell — the dialog is about
    // putting agents to work automatically (scheduled work, alerts, AI monitoring), not about
    // notification settings.
    const autoWhips = el("button", "wd-bell");
    const whipImg = document.createElement("img");
    whipImg.src = autoWhipsIcon;
    whipImg.alt = "";
    whipImg.decoding = "async";
    whipImg.className = "wd-whip-mark";
    autoWhips.appendChild(whipImg);
    autoWhips.setAttribute("aria-label", "Auto-Whips");
    autoWhips.title = "Auto-Whips";
    autoWhips.appendChild(this.alertBadge);
    autoWhips.onclick = () => this.deps.watchers.open();
    this.root.append(status, autoWhips);

    // --- bottom ribbon ---
    const ribbon = el("div", "wd-ribbon");
    this.ribbon = ribbon;
    this.panel = el("div", "wd-panel");
    this.optionsArea = el("div", "wd-options");

    this.tabPanes.set("viewer", this.buildViewerPane());
    this.tabPanes.set("interact", this.buildInteractPane());
    this.tabPanes.set("type", this.buildTypePane());
    this.tabPanes.set("monitor", this.buildMonitorPane());
    for (const pane of this.tabPanes.values()) this.optionsArea.appendChild(pane);

    const tabs = el("div", "wd-tabs");
    const addTab = (tab: Tab, name: IconName, label: string) => {
      const b = el("button", "wd-tab");
      b.appendChild(icon(name, 18));
      b.appendChild(el("span", "wd-tab-label", label));
      b.onclick = () => this.selectTab(tab);
      this.tabButtons.set(tab, b);
      tabs.appendChild(b);
    };
    addTab("viewer", "eye", "Browse");
    addTab("type", "keyboard", "Type");
    addTab("interact", "mouse", "Interact");
    addTab("monitor", "monitor", "Monitor");

    // Fullscreen toggle — CSS reveals it only on a touch device in landscape, where the browser
    // chrome eats scarce vertical space (see .wd-fullscreen). Skipped entirely where the Fullscreen
    // API isn't usable on an element (notably iOS Safari, which only fullscreens <video>), so we
    // never show a dead button. Sits between Monitor and the collapse chevron.
    if (this.fullscreenSupported()) {
      this.fullscreenBtn = iconBtn("fullscreen", "", "wd-collapse wd-fullscreen");
      this.fullscreenBtn.setAttribute("aria-label", "Toggle fullscreen");
      this.fullscreenBtn.title = "Fullscreen";
      this.fullscreenBtn.onclick = () => this.toggleFullscreen();
      tabs.appendChild(this.fullscreenBtn);
      document.addEventListener("fullscreenchange", () => this.syncFullscreenBtn());
    }

    this.collapseBtn = iconBtn("chevron-down", "", "wd-collapse wd-collapse-pane");
    this.collapseBtn.onclick = () => this.setCollapsed(!this.collapsed);
    tabs.appendChild(this.collapseBtn);

    // Hide-the-whole-ribbon toggle — on touch devices it appears once the pane is collapsed (in
    // BOTH orientations now) and REPLACES the pane chevron, so the whole menu can be folded away to
    // the corner handle. ">" folds the entire ribbon away to a slim handle on the right edge; "<"
    // brings it back. Landscape also keeps the fullscreen button; desktop shows neither extra.
    this.hideRibbonBtn = iconBtn("chevron-right", "", "wd-collapse wd-hide-ribbon");
    this.hideRibbonBtn.setAttribute("aria-label", "Hide the whole ribbon");
    this.hideRibbonBtn.title = "Hide toolbar";
    this.hideRibbonBtn.onclick = () => this.setRibbonHidden(!this.ribbonHidden);
    tabs.appendChild(this.hideRibbonBtn);

    this.panel.append(this.optionsArea, tabs);
    ribbon.appendChild(this.panel);
    this.root.appendChild(ribbon);

    // Persistent "left button held" indicator — floats above the screen so the latched state is
    // obvious even while the ribbon is collapsed. Tapping it releases the button.
    this.holdPill = el("button", "wd-hold-pill hidden");
    this.holdPill.type = "button";
    this.holdPill.append(icon("mouse-left-hold", 16), el("span", undefined, "Left button held — tap here to release"));
    this.holdPill.onclick = () => this.deps.input.setLeftHold(false);
    this.root.appendChild(this.holdPill);
    this.deps.input.setLeftHoldListener((held) => this.onLeftHoldChanged(held));

    // Persistent app-switcher bar — same idea as the hold pill: floats above the screen while
    // the host's switcher overlay is open (its ⌘/Alt held down), so the explanation and the
    // actions stay reachable even with the ribbon collapsed. Full-width below the status row:
    // it must hold a real explanation, since the overlay itself may be on an invisible monitor.
    this.switchPill = el("div", "wd-hold-pill wd-switch-pill hidden");
    this.switchPillText = el("div", "wd-switch-text"); // filled per host platform in startAppSwitch
    const tabBtn = el("button", "wd-pill-btn", "Tab");
    tabBtn.type = "button";
    tabBtn.setAttribute("aria-label", "Highlight the next app in the switcher");
    tabBtn.onclick = () => {
      this.deps.conn.send({ type: "key", key: "Tab" });
      navigator.vibrate?.(15);
    };
    const switchBtn = el("button", "wd-pill-btn wd-pill-btn-primary", "Switch");
    switchBtn.type = "button";
    switchBtn.setAttribute("aria-label", "Switch to the highlighted app");
    switchBtn.onclick = () => this.endAppSwitch();
    const cancelBtn = el("button", "wd-pill-btn", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.setAttribute("aria-label", "Close the switcher without switching apps");
    cancelBtn.onclick = () => this.cancelAppSwitch();
    const actions = el("div", "wd-switch-actions");
    actions.append(tabBtn, switchBtn, cancelBtn);
    // Extra row: the OS draws the switcher overlay on ONE monitor (the primary), so it's
    // invisible while the controller views a secondary screen. Filled by updateSwitchPillHint().
    this.switchPillHint = el("div", "wd-pill-hint hidden");
    this.switchPill.append(this.switchPillText, actions, this.switchPillHint);
    this.root.appendChild(this.switchPill);
    // Tapping the screen mirrors the OS: the click dismisses the switcher overlay (or picks the
    // app under the finger), so drop our bar and release the held modifier right after it.
    this.deps.input.setScreenClickListener(() => this.endAppSwitch());

    // Desktop keyboards: forward Ctrl/⌘ C / V / A to the host (paste rides the paste EVENT so the
    // browser hands us the clipboard text without a permissions prompt).
    document.addEventListener("keydown", (e) => this.onGlobalKey(e));
    document.addEventListener("paste", (e) => this.onGlobalPaste(e));

    this.selectTab("viewer");
  }

  /** Reflect the latched left-button state in the Hold button + the floating pill (fired for any
   *  change, incl. the auto-release when leaving Interact/Mouse). */
  private onLeftHoldChanged(held: boolean): void {
    this.holdLeftBtn?.classList.toggle("on", held);
    this.holdPill.classList.toggle("hidden", !held);
  }

  /** Open the host's app switcher and KEEP it open by holding its modifier down (⌘-Tab on a
   *  macOS host, Alt+Tab elsewhere — both switchers live only while the modifier is held).
   *  The floating pill then drives it: Tab cycles, Switch commits. */
  private startAppSwitch(): void {
    if (this.appSwitchActive) return;
    this.appSwitchActive = true;
    this.appSwitchMod = this.hostPlatform === "darwin" ? "meta" : "alt";
    this.deps.conn.send({ type: "key", key: this.appSwitchMod, press: "down" });
    this.deps.conn.send({ type: "key", key: "Tab" });
    const chord = this.hostPlatform === "darwin" ? "⌘+Tab" : "Alt+Tab";
    this.switchPillText.replaceChildren(
      el("strong", undefined, `You're in ${chord} mode. `),
      el("span", undefined, "Tab changes the selection, Switch picks it, Cancel closes without switching."),
    );
    this.appSwitchBtn?.classList.add("on");
    this.switchPill.classList.remove("hidden");
    this.updateSwitchPillHint();
    navigator.vibrate?.(20);
  }

  /** Dismiss the switcher WITHOUT switching: Esc while the modifier is still held is the OS's own
   *  cancel gesture (⌘+Esc / Alt+Esc), then the release is a no-op — focus stays where it was. */
  private cancelAppSwitch(): void {
    if (!this.appSwitchActive) return;
    this.deps.conn.send({ type: "key", key: "Escape" });
    this.endAppSwitch();
  }

  /** The OS draws the switcher overlay on its MAIN monitor only (the Dock's screen on macOS, the
   *  primary on Windows/Linux), so it's invisible while the controller views another display.
   *  Suggest jumping the view there — never force it, since the user may already know which app
   *  is next in the cycle; if the primary can't be identified, at least say where the overlay is. */
  private updateSwitchPillHint(): void {
    const primary = this.displays.find((d) => d.primary);
    const away = primary ? primary.id !== this.activeDisplay : this.displays.length > 1;
    const show = this.appSwitchActive && away;
    this.switchPillHint.classList.toggle("hidden", !show);
    this.switchPillHint.replaceChildren();
    if (!show) return;
    if (primary) {
      this.switchPillHint.appendChild(
        el("span", undefined, `The switcher always shows on the primary monitor (${primary.name}), so you can't see it here.`),
      );
      const view = el("button", "wd-pill-btn wd-pill-btn-sm", "View");
      view.type = "button";
      view.title = "Switch this view to the primary monitor";
      view.onclick = () => this.selectDisplay(primary.id);
      this.switchPillHint.appendChild(view);
    } else {
      this.switchPillHint.appendChild(
        el("span", undefined, "The switcher always shows on the host's primary monitor, so it may not be visible here."),
      );
    }
  }

  /** Release the held switcher modifier — the host switches to the highlighted app. Called by
   *  Switch/Apps, and as the auto-release when leaving Shortcuts/Interact; `send: false` skips
   *  the release message when the connection is already gone (the agent releases it itself). */
  private endAppSwitch(send = true): void {
    if (!this.appSwitchActive) return;
    this.appSwitchActive = false;
    if (send) this.deps.conn.send({ type: "key", key: this.appSwitchMod, press: "up" });
    this.appSwitchBtn?.classList.remove("on");
    this.switchPill.classList.add("hidden");
    navigator.vibrate?.(12);
  }

  private buildViewerPane(): HTMLElement {
    const { view, input, conn } = this.deps;
    // No Click button: tapping the screen clicks directly in every tab (see InputController).
    const pane = el("div", "wd-pane wd-pane-single-row");

    const zoomOut = holdBtn(iconBtn("minus", "", "wd-btn wd-icon-only"), () => view.zoomBy(0.9));
    const zoomIn = holdBtn(iconBtn("plus", "", "wd-btn wd-icon-only"), () => view.zoomBy(1.11));

    const scrollUp = holdBtn(iconBtn("scroll-up", "", "wd-btn wd-icon-only"), () => input.scrollStep(-1));
    const scrollDown = holdBtn(iconBtn("scroll-down", "", "wd-btn wd-icon-only"), () => input.scrollStep(1));
    // Page Up/Down ride the key channel (supported by every input backend on win/mac/linux).
    const pageUp = holdBtn(iconBtn("page-up", "", "wd-btn wd-icon-only"), () =>
      conn.send({ type: "key", key: "PageUp" }),
    );
    pageUp.setAttribute("aria-label", "Page up");
    pageUp.title = "Page up";
    const pageDown = holdBtn(iconBtn("page-down", "", "wd-btn wd-icon-only"), () =>
      conn.send({ type: "key", key: "PageDown" }),
    );
    pageDown.setAttribute("aria-label", "Page down");
    pageDown.title = "Page down";
    const dragScroll = iconBtn("hand", "", "wd-btn wd-icon-only");
    dragScroll.setAttribute("aria-label", "Drag to scroll");
    dragScroll.title = "Drag to scroll";

    // Pan: one finger drags the zoomed screen around (like a strategy-game minimap).
    const pan = iconBtn("drag", "", "wd-btn wd-icon-only");
    pan.setAttribute("aria-label", "Pan the zoomed screen with one finger");
    pan.title = "Pan the zoomed screen with one finger";

    dragScroll.onclick = () => {
      const on = !input.getDragScroll();
      input.setDragScroll(on);
      dragScroll.classList.toggle("on", on);
      pan.classList.toggle("on", input.getPan()); // may have been switched off
    };
    pan.onclick = () => {
      const on = !input.getPan();
      input.setPan(on);
      pan.classList.toggle("on", on);
      dragScroll.classList.toggle("on", input.getDragScroll()); // mutually exclusive
    };

    pane.append(
      group("Zoom", zoomOut, zoomIn),
      group("Pan", pan),
      group("Scroll", scrollUp, scrollDown, pageUp, pageDown, dragScroll),
    );
    return pane;
  }

  private buildInteractPane(): HTMLElement {
    const pane = el("div", "wd-pane");
    this.interactHost = el("div", "wd-pane");
    pane.appendChild(this.interactHost);
    this.renderInteract();
    return pane;
  }

  /** Pointer model behind each Interact segment: Shortcuts keeps Mouse-style taps/drags, so you
   *  can still click into a field or drag-select text before hitting Copy/Paste. */
  private interactionFor(mode: "mouse" | "touch" | "shortcuts"): "mouse" | "touch" {
    return mode === "touch" ? "touch" : "mouse";
  }

  private renderInteract(): void {
    const { input } = this.deps;
    this.interactHost.replaceChildren();
    this.endAppSwitch(); // a held switcher modifier must not survive leaving the Shortcuts segment
    this.holdLeftBtn = null; // reassigned below only in Mouse mode (Touch has no Hold button)
    this.copyBtn = null; // reassigned below only in Shortcuts mode
    this.appSwitchBtn = null; // reassigned below only in Shortcuts mode

    const modeGroup = el("div", "wd-group");
    const head = el("div", "wd-group-head");
    const title = el("span", "wd-group-label", "Mode");
    const toggle = el("div", "wd-mode-toggle");
    for (const [label, mode] of [
      ["Mouse", "mouse"],
      ["Touch", "touch"],
      ["Shortcuts", "shortcuts"],
    ] as const) {
      const b = el("button", "wd-mode-btn", label);
      b.classList.toggle("on", this.interactMode === mode);
      b.onclick = () => {
        this.interactMode = mode;
        if (this.activeTab === "interact") this.deps.input.setInteraction(this.interactionFor(mode));
        this.renderInteract();
      };
      toggle.appendChild(b);
    }
    head.append(title, toggle);

    const items = el("div", "wd-group-items");

    if (this.interactMode === "mouse") {
      // Compact, non-wrapping so all five buttons sit on ONE row (see .wd-compact-row).
      items.classList.add("wd-compact-row");
      const left = iconBtn("mouse-left", "Left");
      left.onclick = () => input.click("left");
      // Latched left-button HOLD, shown as a filled-left-button mouse ("Left" held). Press once to
      // hold the host's left button DOWN, move the cursor to drag/resize a window on the dev machine,
      // press again to release.
      // The `on` state is driven by onLeftHoldChanged so it stays correct through auto-release too.
      const holdLeft = iconBtn("mouse-left-hold", "Left");
      holdLeft.title = "Hold the left button down — grab a window edge, move to resize/drag, tap again to release";
      holdLeft.setAttribute("aria-label", "Hold the left mouse button down");
      holdLeft.classList.toggle("on", input.getLeftHold());
      holdLeft.onclick = () => input.setLeftHold(!input.getLeftHold());
      this.holdLeftBtn = holdLeft;
      const right = iconBtn("mouse-right", "Right");
      right.onclick = () => input.click("right");
      const dbl = iconBtn("double-click", "Double");
      dbl.onclick = () => input.multiClick(2);
      // Modifier-click: opens the link under the cursor in a file/page/doc. The chord is the
      // HOST's — ⌘-click on a macOS host, Ctrl+click elsewhere — so hostModifier() picks it and
      // the agent holds that key around the click. Label stays the outcome ("Link"), not the
      // platform-specific chord, and short enough that the five buttons never wrap.
      const openLink = iconBtn("open-link", "Link");
      openLink.title =
        this.hostPlatform === "darwin"
          ? "Open the link under the cursor (⌘-click)"
          : "Open the link under the cursor (Ctrl+click)";
      openLink.setAttribute("aria-label", "Open the link under the cursor with a modifier-click");
      openLink.onclick = () => input.click("left", false, [this.hostModifier()]);
      items.append(left, holdLeft, right, dbl, openLink);
    } else if (this.interactMode === "shortcuts") {
      // Eight buttons (seven on a Windows host) fold 4+4 on phones and go one-row where there's
      // real room — .wd-shortcut-grid reads the exact count from --wd-shortcut-cols (set below).
      items.classList.add("wd-shortcut-grid");
      const save = iconBtn("save", "Save");
      save.title = "Save in the host's focused app";
      save.onclick = () => this.saveOnHost();
      const selectAll = iconBtn("select-all", "Select all");
      selectAll.title = "Select all in the host's focused app";
      selectAll.onclick = () => this.selectAllOnHost();
      const undo = iconBtn("undo", "Undo");
      undo.title = "Undo in the host's focused app";
      undo.onclick = () => this.undoRedoOnHost(false);
      const redo = iconBtn("redo", "Redo");
      redo.title = "Redo in the host's focused app";
      redo.onclick = () => this.undoRedoOnHost(true);
      const copy = iconBtn("copy", "Copy");
      copy.title = "Copy the text selected on the host to this device";
      copy.onclick = () => this.copyFromHost();
      copy.disabled = !this.clipboardCap || this.copyPending;
      this.copyBtn = copy;
      const paste = iconBtn("paste", "Paste");
      paste.title = "Paste this device's clipboard into the host's focused app";
      paste.onclick = () => this.pasteToHost();
      paste.disabled = !this.clipboardCap;
      // Hold-open app switcher (see startAppSwitch): tapping again commits, same as Switch.
      const apps = iconBtn("apps", "Apps");
      apps.title =
        this.hostPlatform === "darwin"
          ? "Switch between apps (holds ⌘-Tab open)"
          : "Switch between apps and windows (holds Alt+Tab open)";
      apps.classList.toggle("on", this.appSwitchActive);
      apps.onclick = () => (this.appSwitchActive ? this.endAppSwitch() : this.startAppSwitch());
      this.appSwitchBtn = apps;
      const buttons = [save, selectAll, undo, redo, copy, paste, apps];
      // Cycle the windows of the SAME app (e.g. several VS Code windows): ⌘+` on a macOS host,
      // Super+` on Linux (GNOME's default). Windows has no same-app cycle chord — Alt+Tab covers
      // it there — so the button is skipped and the grid falls back to seven cells.
      if (this.hostPlatform !== "win32") {
        const cycle = iconBtn("window-cycle", "Window");
        cycle.title =
          this.hostPlatform === "darwin"
            ? "Next window of the same app (⌘ + `)"
            : "Next window of the same app (Super + `)";
        cycle.onclick = () => {
          this.deps.conn.send({ type: "key", key: "`", modifiers: ["meta"] });
          navigator.vibrate?.(15);
        };
        buttons.push(cycle);
      }
      items.append(...buttons);
      items.style.setProperty("--wd-shortcut-cols", String(buttons.length));
    } else {
      const tap = iconBtn("pointer", "Tap");
      tap.onclick = () => input.click("left");
      const longPress = iconBtn("hand", "Hold");
      longPress.onclick = () => input.longPress();
      const swUp = holdBtn(iconBtn("scroll-up", "Up", "wd-btn"), () => input.swipe(0, -0.25));
      const swDown = holdBtn(iconBtn("scroll-down", "Down", "wd-btn"), () => input.swipe(0, 0.25));
      // Labeled like Up/Down (icon + text) instead of a bare arrow — there's room on the second row.
      const swLeft = holdBtn(iconBtn("chevron-left", "Left", "wd-btn"), () => input.swipe(-0.25, 0));
      const swRight = holdBtn(iconBtn("chevron-right", "Right", "wd-btn"), () => input.swipe(0.25, 0));
      const twoTap = btn("2 fingers");
      twoTap.onclick = () => input.click("right");
      items.append(tap, longPress, swUp, swDown, swLeft, swRight, twoTap);
    }

    modeGroup.append(head, items);
    this.interactHost.append(modeGroup);
    // Select all/Undo/Redo still work against any agent (they ride the plain key channel) — only
    // the clipboard round-trip needs a host that speaks clipboard-copy/clipboard-write.
    if (this.interactMode === "shortcuts" && !this.clipboardCap && this.status === "connected") {
      this.interactHost.append(el("p", "wd-hint", "Copy/Paste needs a newer WhipDesk agent on the host."));
    }
  }

  // ---- host clipboard bridge (Shortcuts segment + desktop Ctrl/⌘ shortcuts) ------------------

  private toast(title: string, body: string, level: NotificationLevel = "info"): void {
    this.deps.notifications.show({
      type: "notification",
      id: `clip-${Date.now()}`,
      title,
      body,
      level,
      source: "client",
      t: Date.now(),
    });
  }

  /** The host's own shortcut modifier — ⌘ on a macOS host, Ctrl everywhere else. */
  private hostModifier(): string {
    return this.hostPlatform === "darwin" ? "meta" : "control";
  }

  /** Ask the host to press its copy shortcut and send back the clipboard (→ clipboard-content). */
  private copyFromHost(): void {
    if (!this.clipboardCap || this.copyPending) return;
    this.armGestureCopy();
    this.deps.conn.send({ type: "clipboard-copy" });
    this.setCopyPending(true);
    // Re-enable even if the reply never arrives (link blip / very old agent).
    this.copyTimeout = window.setTimeout(() => {
      this.abortGestureCopy();
      this.setCopyPending(false);
    }, 5000);
  }

  /**
   * Begin the local clipboard write NOW, inside the user's tap, handing the browser a PROMISE for
   * the text. Safari (iOS + macOS) refuses any clipboard write that starts outside a user gesture —
   * this promise-ClipboardItem form is the one async pattern it accepts, and it's what lets an
   * iPhone Copy land directly on the phone's clipboard with no dialog. Browsers that don't take
   * promise payloads just reject, and the reply path falls back to writeText / the manual dialog.
   */
  private armGestureCopy(): void {
    this.copyWriteAttempt = null;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
    const pending = new Promise<Blob>((resolve, reject) => {
      this.pendingCopyResolve = resolve;
      this.pendingCopyReject = reject;
    });
    pending.catch(() => {}); // aborts (timeout / empty host clipboard) are expected, never unhandled
    try {
      this.copyWriteAttempt = navigator.clipboard
        .write([new ClipboardItem({ "text/plain": pending })])
        .then(() => true, () => false);
    } catch {
      this.abortGestureCopy(); // ClipboardItem refused the promise payload — plan B on reply
    }
  }

  private abortGestureCopy(): void {
    this.pendingCopyReject?.();
    this.pendingCopyReject = null;
    this.pendingCopyResolve = null;
    this.copyWriteAttempt = null;
  }

  private setCopyPending(pending: boolean): void {
    window.clearTimeout(this.copyTimeout);
    this.copyPending = pending;
    if (this.copyBtn) this.copyBtn.disabled = pending || !this.clipboardCap;
  }

  /** The host answered a copy request: land its text on THIS device's clipboard. */
  handleClipboardContent(content: { text: string; truncated?: boolean }): void {
    this.setCopyPending(false);
    if (!content.text) {
      this.abortGestureCopy();
      this.toast("Nothing copied", `No text was selected on ${this.deviceName || "the host"} (its clipboard is empty).`);
      return;
    }
    const note = content.truncated ? " (long text — truncated)" : "";
    // Preferred: feed the write that STARTED inside the tap (Safari's requirement) and see
    // whether the browser accepted it.
    const attempt = this.copyWriteAttempt;
    const resolve = this.pendingCopyResolve;
    this.pendingCopyResolve = null;
    this.pendingCopyReject = null;
    this.copyWriteAttempt = null;
    if (attempt && resolve) {
      resolve(new Blob([content.text], { type: "text/plain" }));
      void attempt.then((ok) => (ok ? this.toastCopied(note) : this.writeTextOrDialog(content.text, note)));
      return;
    }
    this.writeTextOrDialog(content.text, note);
  }

  private toastCopied(note: string): void {
    this.toast("Copied", `Text from ${this.deviceName || "the host"} is on this device's clipboard${note}.`, "success");
  }

  /** Plan B: plain writeText (fine outside a gesture on Chrome), else the manual copy dialog.
   *  navigator.clipboard doesn't exist at all on a plain-http LAN session — dialog it is. */
  private writeTextOrDialog(text: string, note: string): void {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this.toastCopied(note),
        () => this.openCopyFallback(text),
      );
    } else {
      this.openCopyFallback(text);
    }
  }

  /** Send text to the host clipboard and press its paste shortcut. */
  private sendClipboardText(text: string): void {
    if (!text || !this.clipboardCap) return;
    if (text.length > CLIPBOARD_MAX_TEXT) {
      text = text.slice(0, CLIPBOARD_MAX_TEXT);
      this.toast("Text truncated", "The pasted text was very long and was cut off.", "warning");
    }
    this.deps.conn.send({ type: "clipboard-write", text, paste: true });
    navigator.vibrate?.(15);
  }

  /** Paste button: read THIS device's clipboard if the browser allows it, else ask via dialog. */
  private pasteToHost(): void {
    if (!this.clipboardCap) return;
    if (!navigator.clipboard?.readText) return this.openPasteFallback();
    navigator.clipboard.readText().then(
      (text) => (text ? this.sendClipboardText(text) : this.openPasteFallback()),
      () => this.openPasteFallback(), // permission denied / unsupported — type or paste manually
    );
  }

  /** Select all in the host's focused app (⌘A on a macOS host, Ctrl+A elsewhere). */
  private selectAllOnHost(): void {
    this.deps.conn.send({ type: "key", key: "a", modifiers: [this.hostModifier()] });
    navigator.vibrate?.(15);
  }

  /** Save in the host's focused app (⌘S on a macOS host, Ctrl+S elsewhere). */
  private saveOnHost(): void {
    this.deps.conn.send({ type: "key", key: "s", modifiers: [this.hostModifier()] });
    navigator.vibrate?.(15);
  }

  /** Undo/redo in the host's focused app, with the platform-true redo chord:
   *  ⇧⌘Z on macOS, Ctrl+Y on Windows, Ctrl+Shift+Z elsewhere. */
  private undoRedoOnHost(redo: boolean): void {
    if (!redo) {
      this.deps.conn.send({ type: "key", key: "z", modifiers: [this.hostModifier()] });
    } else if (this.hostPlatform === "win32") {
      this.deps.conn.send({ type: "key", key: "y", modifiers: ["control"] });
    } else {
      this.deps.conn.send({ type: "key", key: "z", modifiers: [this.hostModifier(), "shift"] });
    }
    navigator.vibrate?.(15);
  }

  /** Manual copy dialog: shown only when every direct write path was refused (plain-http LAN). */
  private openCopyFallback(text: string): void {
    const dialog = this.openClipDialog({
      title: `Copied from ${this.deviceName || "host"}`,
      help: "Browsers block direct clipboard writes on LAN (http) connections. Check the text below, then press Copy to clipboard.",
      action: "Copy to clipboard",
      onAction: () => this.copyDialogText(dialog),
    });
    dialog.ta.value = text;
    dialog.ta.readOnly = true;
  }

  /**
   * Copy the dialog textarea SYNCHRONOUSLY inside the button tap. iOS Safari ignores programmatic
   * selection on a readonly control and drops any selection made before the tap, so it all has to
   * happen here, in one gesture: un-readonly → focus → select → execCommand("copy") → restore.
   * The selection itself is belt-and-braces (a DOM Range plus setSelectionRange — iOS has dropped
   * each one alone), and it is VERIFIED before trusting execCommand, which can report success
   * while nothing was selected. writeText is the async plan B; failing that, copy by hand.
   */
  private copyDialogText(dialog: ClipDialog): void {
    const { ta } = dialog;
    ta.readOnly = false;
    ta.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, ta.value.length);
    const selected = ta.value.length > 0 && ta.selectionEnd - ta.selectionStart === ta.value.length;
    let ok = false;
    try {
      ok = selected && document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.readOnly = true;
    ta.blur(); // put the mobile keyboard away
    if (ok) return this.confirmCopyDialog(dialog);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(ta.value).then(
        () => this.confirmCopyDialog(dialog),
        () => this.toast("Copy failed", "Select the text in the box and copy it manually.", "warning"),
      );
    } else {
      this.toast("Copy failed", "Select the text in the box and copy it manually.", "warning");
    }
  }

  /** In-dialog confirmation: the button morphs to "✓ Copied" for a beat, then the dialog closes. */
  private confirmCopyDialog(dialog: ClipDialog): void {
    dialog.action.replaceChildren(icon("check", 16), el("span", "wd-btn-label", "Copied"));
    dialog.action.disabled = true;
    window.setTimeout(dialog.close, 900);
  }

  /** Manual paste dialog for browsers that won't hand us the clipboard up front (a declined or
   *  re-promptable permission, Firefox, plain-http LAN). One press of "Paste to host" reads the
   *  clipboard itself when the API exists — the permission prompt then appears inside that tap.
   *  On plain-http LAN the browser exposes NO clipboard-read API at all, so the paste EVENT
   *  (long-press → Paste / Ctrl+V) is the only bridge — it sends the instant text lands. */
  private openPasteFallback(): void {
    const canRead = !!navigator.clipboard?.readText;
    const dialog = this.openClipDialog({
      title: `Paste to ${this.deviceName || "host"}`,
      help: canRead
        ? "This browser asks before handing over the clipboard. Press Paste to host and allow it — or paste into the box; it's sent the moment the text lands."
        : "Browsers block clipboard reading on LAN (http) connections, so one step is manual: tap the box and long-press → Paste (or press Ctrl+V). The text is sent the moment it lands.",
      action: "Paste to host",
      onAction: (value) => {
        if (value) return sendNow(value);
        // Empty box: fetch the clipboard right here, inside the tap, where the browser allows it.
        if (navigator.clipboard?.readText) {
          navigator.clipboard.readText().then(
            (text) =>
              text ? sendNow(text) : this.toast("Clipboard is empty", "Copy some text first, then try again.", "warning"),
            () => this.toast("Clipboard access refused", "Paste into the box instead — it sends automatically.", "warning"),
          );
        } else {
          this.toast("Nothing to send", "Long-press in the box and tap Paste — it sends automatically.", "warning");
        }
      },
    });
    const sendNow = (text: string) => {
      if (!text) return;
      dialog.close();
      this.sendClipboardText(text);
      this.toast("Sent", `Pasted to ${this.deviceName || "the host"}.`, "success");
    };
    // The paste EVENT hands us the text with no permission prompt — the moment it lands, send it.
    dialog.ta.addEventListener("paste", (e) => {
      const pasted = e.clipboardData?.getData("text/plain") ?? "";
      if (!pasted) return;
      e.preventDefault();
      sendNow(pasted);
    });
    dialog.ta.placeholder = "Paste text here…";
    dialog.ta.focus();
  }

  /** One-off clipboard dialog (standard overlay: backdrop tap + Esc dismiss). */
  private openClipDialog(opts: {
    title: string;
    help: string;
    action: string;
    onAction: (value: string, close: () => void) => void;
  }): ClipDialog {
    this.clipOverlay?.remove(); // never stack two clipboard dialogs
    const overlay = el("div", "wd-dialog-overlay");
    this.clipOverlay = overlay;
    const close = () => {
      overlay.remove();
      if (this.clipOverlay === overlay) this.clipOverlay = null;
    };
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close();
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    head.append(el("h2", "", opts.title));
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = close;
    head.appendChild(x);
    const help = el("p", "wd-dialog-help", opts.help);
    const ta = el("textarea", "wd-clip-text");
    ta.rows = 5;
    const actions = el("div", "wd-dialog-actions");
    const go = el("button", "wd-btn wd-go", opts.action);
    go.onclick = () => opts.onAction(ta.value, close);
    actions.appendChild(go);
    card.append(head, help, ta, actions);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
    return { ta, action: go, close };
  }

  /** True when the event targets a field that should keep the browser's native clipboard keys. */
  private isEditableTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]");
  }

  /**
   * Desktop-to-desktop shortcuts: Ctrl/⌘+C copies the HOST's selection, Ctrl/⌘+A selects all
   * there, Ctrl/⌘+S saves there, Ctrl/⌘+Z / ⇧⌘Z / Ctrl+Y undo/redo there. Never intercepted while
   * typing in a local field, and a local on-page selection keeps native copy so dialog/notification
   * text stays copyable. (Ctrl/⌘+V arrives via onGlobalPaste — the paste EVENT hands us the
   * clipboard text without any permission prompt.)
   */
  private onGlobalKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (this.status !== "connected" || this.isEditableTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === "z") {
      e.preventDefault();
      this.undoRedoOnHost(e.shiftKey);
      return;
    }
    if (e.shiftKey) return;
    if (key === "c") {
      if (window.getSelection()?.toString()) return;
      if (!this.clipboardCap) return;
      e.preventDefault();
      this.copyFromHost();
    } else if (key === "a") {
      e.preventDefault();
      this.selectAllOnHost();
    } else if (key === "s") {
      // Also stops the browser's own "save this page" dialog from opening over the session.
      e.preventDefault();
      this.saveOnHost();
    } else if (key === "y") {
      e.preventDefault();
      this.undoRedoOnHost(true);
    }
  }

  private onGlobalPaste(e: ClipboardEvent): void {
    if (this.status !== "connected" || !this.clipboardCap || this.isEditableTarget(e.target)) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    this.sendClipboardText(text);
  }

  private buildTypePane(): HTMLElement {
    const { conn, input } = this.deps;
    const pane = el("div", "wd-pane wd-pane-col");

    this.promptInput = el("textarea", "wd-type-input");
    this.promptInput.placeholder = "Type to send to the focused app (URL, command, message…)";
    this.promptInput.rows = 2;
    // Terminal-style history: ArrowUp/Down recall recently sent prompts (only when the caret is on
    // the first/last line, so multi-line editing still works). Manual edits leave history mode.
    this.promptInput.addEventListener("keydown", (e) => this.onPromptKey(e));
    this.promptInput.addEventListener("input", () => {
      this.histIndex = -1;
      this.updateHistButtons();
      this.syncPromptHeight();
    });

    // History recall (mobile has no ↑/↓ keys): a tiny stacked column — prev on top, next below —
    // walks the recently sent prompts, restoring the in-progress draft when you step back past the
    // newest (same feel as VS Code / GitHub Copilot chat history).
    const histNav = el("div", "wd-type-history");
    const histPrev = iconBtn("chevron-up", "", "wd-btn wd-icon-only wd-hist-btn");
    histPrev.title = "Recall previous prompt";
    histPrev.setAttribute("aria-label", "Recall previous prompt");
    histPrev.onclick = () => this.recallPrev();
    const histNext = iconBtn("chevron-down", "", "wd-btn wd-icon-only wd-hist-btn");
    histNext.title = "Recall next prompt";
    histNext.setAttribute("aria-label", "Recall next prompt");
    histNext.onclick = () => this.recallNext();
    histNav.append(histPrev, histNext);
    this.histPrevBtn = histPrev;
    this.histNextBtn = histNext;
    this.updateHistButtons();

    // The Whipository button lives right next to the box it injects into (on the right), so it's
    // obvious the saved whip lands in THIS textarea — not straight on the host. Same square-icon
    // treatment as the scheduled-work prompt entry.
    const inputRow = el("div", "wd-type-input-row");
    const whipsBeside = whipButton(() => this.deps.whipository.open((text) => this.insertIntoPrompt(text)));
    inputRow.append(this.promptInput, histNav, whipsBeside);

    // Special keys share ONE row that never wraps: equal-width keys that shrink to fit, so all
    // eight stay on a single line even on a 320–375px phone (see .wd-keys-row).
    const keys = el("div", "wd-keys-row");
    for (const [label, key] of SPECIAL_KEYS) {
      const b = btn(label);
      b.onclick = () => conn.send({ type: "key", key });
      keys.appendChild(b);
    }

    // Action row: 1×/2×/3× click + Whips + Insert + Send share ONE nowrap row, so the labels are
    // deliberately terse (full names live in title/aria). 1× is here so a quick focus-click before
    // typing (select a field, dismiss a popup) never forces a tab switch away from Type.
    const actions = el("div", "wd-type-actions");
    const single = iconBtn("pointer", "1×");
    single.title = "Click";
    single.setAttribute("aria-label", "Click");
    single.onclick = () => input.click("left");
    const dbl = iconBtn("double-click", "2×");
    dbl.title = "Double-click";
    dbl.setAttribute("aria-label", "Double-click");
    dbl.onclick = () => input.multiClick(2);
    const triple = iconBtn("double-click", "3×");
    triple.title = "Triple-click";
    triple.setAttribute("aria-label", "Triple-click");
    triple.onclick = () => input.multiClick(3);
    const insert = iconBtn("insert", "Insert");
    insert.onclick = () => this.sendText(false);
    const send = iconBtn("send", "Send", "wd-btn wd-go");
    send.onclick = () => this.sendText(true);
    // Whipository now lives beside the textarea (inputRow) instead of in this action row.
    actions.append(single, dbl, triple, insert, send);

    pane.append(inputRow, keys, actions);
    return pane;
  }

  // ---- Type-tab prompt history (terminal-style ↑/↓ recall) ------------------
  private onPromptKey(e: KeyboardEvent): void {
    if (e.key === "ArrowUp" && this.caretOnFirstLine()) {
      e.preventDefault();
      this.recallPrev();
    } else if (e.key === "ArrowDown" && this.caretOnLastLine()) {
      e.preventDefault();
      this.recallNext();
    }
  }

  /** True when the caret is a collapsed selection on the FIRST line (no newline before it). */
  private caretOnFirstLine(): boolean {
    const ta = this.promptInput;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    return ta.value.lastIndexOf("\n", ta.selectionStart - 1) === -1;
  }

  /** True when the caret is a collapsed selection on the LAST line (no newline at/after it). */
  private caretOnLastLine(): boolean {
    const ta = this.promptInput;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    return ta.value.indexOf("\n", ta.selectionStart) === -1;
  }

  /** Walk to an older prompt (↑). Snapshots the in-progress draft the first time we leave the bottom. */
  private recallPrev(): void {
    const items = this.typeHistory.list();
    if (items.length === 0) return;
    if (this.histIndex < 0 || this.histIndex > items.length) this.histIndex = items.length; // normalize to bottom
    if (this.histIndex === items.length) this.histDraft = this.promptInput.value;
    if (this.histIndex === 0) return; // already at the oldest entry
    this.histIndex -= 1;
    this.setPromptValue(items[this.histIndex] ?? "");
    this.updateHistButtons();
  }

  /** Walk toward newer prompts (↓); stepping past the newest restores the saved draft. */
  private recallNext(): void {
    const items = this.typeHistory.list();
    if (this.histIndex < 0 || this.histIndex >= items.length) return; // already at the draft/bottom
    this.histIndex += 1;
    if (this.histIndex >= items.length) {
      this.histIndex = items.length;
      this.setPromptValue(this.histDraft);
    } else {
      this.setPromptValue(items[this.histIndex] ?? "");
    }
    this.updateHistButtons();
  }

  /** Grey out ↑ when there's nothing older to recall and ↓ when we're already back at the live draft,
   *  so the arrows show at a glance which end of the history you're on (like a shell's ↑/↓ bounds). */
  private updateHistButtons(): void {
    if (!this.histPrevBtn || !this.histNextBtn) return;
    const n = this.typeHistory.list().length;
    const atBottom = this.histIndex < 0 || this.histIndex >= n; // showing the live draft, not a recalled entry
    this.histPrevBtn.disabled = n === 0 || this.histIndex === 0; // nothing older left
    this.histNextBtn.disabled = atBottom; // nothing newer than the draft
  }

  /** Replace the prompt text and drop the caret at the end (so the next ↑/↓ keeps navigating). */
  private setPromptValue(text: string): void {
    const ta = this.promptInput;
    ta.value = text;
    const end = text.length;
    ta.setSelectionRange(end, end);
    ta.focus();
    this.syncPromptHeight();
  }

  /** Insert whip text at the cursor of the Type textarea (replacing any selection). */
  private insertIntoPrompt(text: string): void {
    const ta = this.promptInput;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    this.syncPromptHeight();
  }

  /** Chat-style auto-grow: the Type box tracks its draft up to the CSS max-height, then scrolls.
   * Growing first matters on iOS, where panning a small overflowing textarea inside the fixed
   * ribbon is unreliable — this keeps most drafts fully visible with no scrolling needed at all.
   * (+2 covers the 1px borders; height is border-box.) */
  private syncPromptHeight(): void {
    const ta = this.promptInput;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }

  private buildMonitorPane(): HTMLElement {
    const pane = el("div", "wd-pane");
    this.monitorList = el("div", "wd-monitor-list");
    pane.appendChild(this.monitorList);
    this.renderMonitors();
    return pane;
  }

  private renderMonitors(): void {
    if (!this.monitorList) return;
    this.monitorList.replaceChildren();
    if (this.displays.length === 0) {
      this.monitorList.appendChild(el("span", "wd-hint", "Single display"));
      return;
    }
    this.displays.forEach((d) => {
      // The host already provides friendly names ("Display 1", monitor models, …), so show them
      // as-is with a star for the primary — no redundant leading index.
      const label = `${d.name}${d.primary ? " ★" : ""}`;
      const b = btn(label);
      b.classList.toggle("on", d.id === this.activeDisplay);
      b.onclick = () => this.selectDisplay(d.id);
      this.monitorList.appendChild(b);
    });
  }

  private selectTab(tab: Tab): void {
    if (this.activeTab !== null && tab === this.activeTab) {
      this.setCollapsed(!this.collapsed);
      return;
    }
    this.activeTab = tab;
    if (this.collapsed) this.setCollapsed(false);
    // Leaving Interact must release a held switcher modifier, like setInteraction below releases
    // a latched left button — neither may get stuck down on the host.
    if (tab !== "interact") this.endAppSwitch();
    for (const [key, b] of this.tabButtons) b.classList.toggle("on", key === tab);
    for (const [key, pane] of this.tabPanes) pane.classList.toggle("hidden", key !== tab);

    // Map the tab to an interaction model. Interact uses the currently selected mode; the other
    // tabs use "viewer", where a tap also clicks directly (double/triple taps = double/triple
    // clicks) unless the Pan or drag-to-scroll tool is active.
    this.deps.input.setInteraction(tab === "interact" ? this.interactionFor(this.interactMode) : "viewer");
    if (tab === "type") window.setTimeout(() => this.promptInput.focus(), 50);
  }

  /** True when the browser can fullscreen an element (excludes iOS Safari, which only does <video>). */
  private fullscreenSupported(): boolean {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown };
    return typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function";
  }

  private fullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  private toggleFullscreen(): void {
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (this.fullscreenElement()) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
      else doc.webkitExitFullscreen?.();
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => {});
    } else {
      el.webkitRequestFullscreen?.();
    }
    this.syncFullscreenBtn();
  }

  /** Swap the button glyph between enter/exit as fullscreen state changes. */
  private syncFullscreenBtn(): void {
    if (!this.fullscreenBtn) return;
    const on = !!this.fullscreenElement();
    this.fullscreenBtn.replaceChildren(icon(on ? "fullscreen-exit" : "fullscreen"));
    this.fullscreenBtn.title = on ? "Exit fullscreen" : "Fullscreen";
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.optionsArea.classList.toggle("hidden", collapsed);
    // Mirrored on the ribbon so CSS can swap the pane chevron for the hide-ribbon toggle in portrait.
    this.ribbon.classList.toggle("collapsed", collapsed);
    this.collapseBtn.replaceChildren(icon(collapsed ? "chevron-up" : "chevron-down"));
  }

  private setRibbonHidden(hidden: boolean): void {
    this.ribbonHidden = hidden;
    this.ribbon.classList.toggle("ribbon-hidden", hidden);
    // ">" folds it away; the lone "<" handle brings it back.
    this.hideRibbonBtn.replaceChildren(icon(hidden ? "chevron-left" : "chevron-right"));
    this.hideRibbonBtn.title = hidden ? "Show toolbar" : "Hide toolbar";
    this.hideRibbonBtn.setAttribute("aria-label", hidden ? "Show the ribbon" : "Hide the whole ribbon");
  }

  private sendText(submit: boolean): void {
    const text = this.promptInput.value;
    if (!text) return;
    this.deps.conn.send({ type: "type", text, submit });
    this.typeHistory.add(text); // remember it for ↑/↓ recall
    this.promptInput.value = "";
    this.histIndex = -1;
    this.histDraft = "";
    this.updateHistButtons();
    this.syncPromptHeight();
  }
}
