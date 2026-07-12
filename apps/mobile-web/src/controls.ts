import type { DisplayInfo, WelcomeMessage } from "@whipdesk/protocol";
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
 *  - Interact: full control — Mouse|Touch segment. Mouse: Left, Left-held (latched button-down for
 *    dragging/resizing host windows), Right, Double, Drag.
 *  - Monitor:  pick which display to view + control.
 *
 * A chevron collapses the whole ribbon to a slim handle to free the screen.
 */
export class Controls {
  private readonly statusDot = el("span", "wd-dot");
  private readonly statusText = el("span", "wd-status-text", "Connecting…");
  private readonly transportBadge = el("span", "wd-transport hidden");
  private readonly watchersText = el("span", "wd-watchers", "");
  private readonly alertBadge = el("span", "wd-badge hidden");
  private statusbar!: HTMLElement;
  private statusCollapseTimer = 0;
  private connectionOverlay!: HTMLElement;
  private connName!: HTMLElement;
  private connRoute!: HTMLElement;
  private connPresence!: HTMLElement;
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

  private activeTab: Tab | null = null;
  private interactMode: "mouse" | "touch" = "mouse";
  private collapsed = false;
  private ribbonHidden = false;
  private deviceName = "";
  private transport = "";
  private presenceCount = 1;
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
    this.renderStatusText();
    this.displays = w.displays ?? [];
    this.activeDisplay = w.activeDisplay ?? 0;
    this.renderMonitors();
    if (!w.capabilities.mouse) {
      this.deps.notifications.show({
        type: "notification",
        id: `cap-${Date.now()}`,
        title: "View-only",
        body: "Host mouse/keyboard unavailable — grant Accessibility on the host.",
        level: "warning",
        source: "client",
        t: Date.now(),
      });
    }
  }

  setActiveDisplay(id: number): void {
    this.activeDisplay = id;
    this.renderMonitors();
  }

  /** How many controllers (incl. this one) are connected to the host. */
  setPresence(watchers: number): void {
    this.presenceCount = watchers;
    this.watchersText.textContent = watchers > 1 ? `● ${watchers} watching` : "";
    if (this.connectionOverlay && !this.connectionOverlay.classList.contains("hidden")) this.renderConnection();
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

    const viewersRow = el("div", "wd-conn-row");
    viewersRow.append(el("span", "wd-conn-label", "Viewers"));
    this.connPresence = el("span", "wd-conn-value", "1");
    viewersRow.appendChild(this.connPresence);

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

    // Row order: Status, Connection, Speed, Machine (+HDR note), Viewers.
    card.append(head, statusRow, routeRow, speedRow, nameRow, this.connHdr, viewersRow, this.connError, disconnect, support, feedback);
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
    this.connPresence.textContent = String(Math.max(1, this.presenceCount));
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
    status.append(this.statusDot, this.statusText, this.transportBadge, this.watchersText);
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

    this.selectTab("viewer");
  }

  /** Reflect the latched left-button state in the Hold button + the floating pill (fired for any
   *  change, incl. the auto-release when leaving Interact/Mouse). */
  private onLeftHoldChanged(held: boolean): void {
    this.holdLeftBtn?.classList.toggle("on", held);
    this.holdPill.classList.toggle("hidden", !held);
  }

  private buildViewerPane(): HTMLElement {
    const { view, input, conn } = this.deps;
    // No Click button: tapping the screen clicks directly in every tab (see InputController).
    const pane = el("div", "wd-pane wd-pane-single-row");

    const zoomOut = holdBtn(iconBtn("minus", "", "wd-btn wd-icon-only"), () => view.zoomBy(0.9));
    const zoomIn = holdBtn(iconBtn("plus", "", "wd-btn wd-icon-only"), () => view.zoomBy(1.11));

    const scrollUp = holdBtn(iconBtn("scroll-up", "", "wd-btn wd-icon-only"), () => input.scrollStep(-6));
    const scrollDown = holdBtn(iconBtn("scroll-down", "", "wd-btn wd-icon-only"), () => input.scrollStep(6));
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

  private renderInteract(): void {
    const { input } = this.deps;
    this.interactHost.replaceChildren();
    this.holdLeftBtn = null; // reassigned below only in Mouse mode (Touch has no Hold button)

    const modeGroup = el("div", "wd-group");
    const head = el("div", "wd-group-head");
    const title = el("span", "wd-group-label", "Mode");
    const toggle = el("div", "wd-mode-toggle");
    const mouse = el("button", "wd-mode-btn", "Mouse");
    const touch = el("button", "wd-mode-btn", "Touch");
    mouse.classList.toggle("on", this.interactMode === "mouse");
    touch.classList.toggle("on", this.interactMode === "touch");
    mouse.onclick = () => {
      this.interactMode = "mouse";
      if (this.activeTab === "interact") this.deps.input.setInteraction("mouse");
      this.renderInteract();
    };
    touch.onclick = () => {
      this.interactMode = "touch";
      if (this.activeTab === "interact") this.deps.input.setInteraction("touch");
      this.renderInteract();
    };
    toggle.append(mouse, touch);
    head.append(title, toggle);

    const items = el("div", "wd-group-items");

    if (this.interactMode === "mouse") {
      // Compact, non-wrapping so all five buttons sit on ONE row (see .wd-compact-row).
      items.classList.add("wd-compact-row");
      const left = iconBtn("mouse-left", "Left");
      left.onclick = () => input.click("left");
      // Latched left-button HOLD, shown as a filled-left-button mouse ("Left" held). Press once to
      // hold the host's left button DOWN, move the cursor to drag/resize a window on the dev machine,
      // press again to release. Distinct from Drag (which only holds during a single continuous drag).
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
      const dragHold = iconBtn("drag", "Drag");
      dragHold.onclick = () => {
        const on = !input.getDragLock();
        input.setDragLock(on);
        dragHold.classList.toggle("on", on);
      };
      items.append(left, holdLeft, right, dbl, dragHold);
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

    // Special keys wrap together so no single key takes a whole row.
    const keys = el("div", "wd-wrap");
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
      b.onclick = () => {
        this.deps.conn.send({ type: "select-display", id: d.id });
        this.activeDisplay = d.id;
        this.renderMonitors();
      };
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
    for (const [key, b] of this.tabButtons) b.classList.toggle("on", key === tab);
    for (const [key, pane] of this.tabPanes) pane.classList.toggle("hidden", key !== tab);

    // Map the tab to an interaction model. Interact uses the currently selected mode; the other
    // tabs use "viewer", where a tap also clicks directly (double/triple taps = double/triple
    // clicks) unless the Pan or drag-to-scroll tool is active.
    this.deps.input.setInteraction(tab === "interact" ? this.interactMode : "viewer");
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
  }
}
