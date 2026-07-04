import type { DisplayInfo, WelcomeMessage } from "@whipdesk/protocol";
import type { ConnectionStatus, ControllerTransport } from "./core";
import type { InputController } from "./input";
import type { Notifications } from "./notifications";
import type { ScreenView } from "./screen";
import type { RegionWatchers } from "./watchers";
import type { Whipository } from "./whipository";
import { icon, type IconName } from "./icons";
import { DONATE_URL, GITHUB_URL, REDDIT_URL, dashboardUrl } from "./site";
import whipMark from "./assets/whip.png";

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
 *  - Viewer:   zoom −/+, pan, scroll/page; tap the screen to click, just like the real device.
 *  - Interact: full control — Mouse|Touch segment, then Left/Right/Double/Drag/Scroll.
 *  - Type:     write text — textarea + special keys + Insert (no Enter) / Send (Enter).
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
  private interactHost!: HTMLElement;

  private monitorList!: HTMLElement;
  private promptInput!: HTMLTextAreaElement;

  private activeTab: Tab | null = null;
  private interactMode: "mouse" | "touch" = "mouse";
  private collapsed = false;
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

    const nameRow = el("div", "wd-conn-row");
    nameRow.append(el("span", "wd-conn-label", "Machine"));
    this.connName = el("span", "wd-conn-value", "—");
    nameRow.appendChild(this.connName);

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
    card.append(head, statusRow, routeRow, speedRow, nameRow, this.connHdr, viewersRow, this.connError, disconnect, feedback);
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
      // Relay (TURN) traffic costs us real money — so right where the description says "Consider
      // supporting us", drop the donate button into the Connection value field.
      if (this.transport.toLowerCase() === "turn") {
        const donate = el("button", "wd-support-link");
        donate.append(icon("heart", 14), el("span", undefined, "Support WhipDesk"));
        donate.onclick = () => window.open(DONATE_URL, "_blank", "noopener");
        this.connRoute.append(donate);
      }
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

    // Auto-Whips button: the project's whip mark, not a notification bell — the dialog is about
    // putting agents to work automatically (scheduled work, alerts, AI monitoring), not about
    // notification settings.
    const autoWhips = el("button", "wd-bell");
    const whipImg = document.createElement("img");
    whipImg.src = whipMark;
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
    addTab("viewer", "eye", "Viewer");
    addTab("interact", "mouse", "Interact");
    addTab("type", "keyboard", "Type");
    addTab("monitor", "monitor", "Monitor");

    this.collapseBtn = iconBtn("chevron-down", "", "wd-collapse");
    this.collapseBtn.onclick = () => this.setCollapsed(!this.collapsed);
    tabs.appendChild(this.collapseBtn);

    this.panel.append(this.optionsArea, tabs);
    ribbon.appendChild(this.panel);
    this.root.appendChild(ribbon);

    this.selectTab("viewer");
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
      const left = iconBtn("mouse-left", "Left");
      left.onclick = () => input.click("left");
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
      items.append(left, right, dbl, dragHold);
    } else {
      const tap = iconBtn("pointer", "Tap");
      tap.onclick = () => input.click("left");
      const longPress = iconBtn("hand", "Hold");
      longPress.onclick = () => input.longPress();
      const swUp = holdBtn(iconBtn("scroll-up", "Up", "wd-btn"), () => input.swipe(0, -0.25));
      const swDown = holdBtn(iconBtn("scroll-down", "Down", "wd-btn"), () => input.swipe(0, 0.25));
      const swLeft = btn("←");
      swLeft.onclick = () => input.swipe(-0.25, 0);
      const swRight = btn("→");
      swRight.onclick = () => input.swipe(0.25, 0);
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

    // All buttons wrap together so no single button takes a whole row.
    const buttons = el("div", "wd-wrap");
    for (const [label, key] of SPECIAL_KEYS) {
      const b = btn(label);
      b.onclick = () => conn.send({ type: "key", key });
      buttons.appendChild(b);
    }
    // 1x/2x/3x click (same pointer icon family as the Viewer tab, compact labels — three buttons
    // must share the cramped Type row). 1x is here so a quick focus-click before typing (select a
    // field, dismiss a popup) never forces a tab switch away from Type.
    const single = iconBtn("pointer", "1x click");
    single.onclick = () => input.click("left");
    const dbl = iconBtn("double-click", "2x click");
    dbl.onclick = () => input.multiClick(2);
    const triple = iconBtn("double-click", "3x click");
    triple.onclick = () => input.multiClick(3);
    const insert = iconBtn("insert", "Insert");
    insert.onclick = () => this.sendText(false);
    const send = iconBtn("send", "Send", "wd-btn wd-go");
    send.onclick = () => this.sendText(true);
    // Whipository: saved reusable prompts. Picking one lands in THIS textarea (never straight on
    // the host), so the user can still tweak before Insert/Send.
    const whips = iconBtn("book", "Whips");
    whips.title = "Whipository — insert a saved prompt";
    whips.onclick = () => this.deps.whipository.open((text) => this.insertIntoPrompt(text));
    buttons.append(single, dbl, triple, whips, insert, send);

    pane.append(this.promptInput, buttons);
    return pane;
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

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.optionsArea.classList.toggle("hidden", collapsed);
    this.collapseBtn.replaceChildren(icon(collapsed ? "chevron-up" : "chevron-down"));
  }

  private sendText(submit: boolean): void {
    const text = this.promptInput.value;
    if (!text) return;
    this.deps.conn.send({ type: "type", text, submit });
    this.promptInput.value = "";
  }
}
