import type { AgentKind, Lash, MonitorInfo, MonitorSessionInfo, ScheduledAction, TimerInfo, WatchRegion } from "@whipdesk/protocol";
import type { ControllerTransport } from "./core";
import type { LashStash } from "./lashstash";
import type { Notifications } from "./notifications";
import type { ScreenView } from "./screen";
import type { Whipository } from "./whipository";
import { icon } from "./icons";
import { placeTarget } from "./placement";
import { GITHUB_URL } from "./site";
import whipMark from "./assets/whip.png";

let counter = 0;
function uid(): string {
  return `w${Date.now().toString(36)}${(counter++).toString(36)}`;
}

/** Default alert name: the moment it was created, e.g. "Jun 25, 02:32 PM". */
function defaultAlertName(): string {
  return new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human-readable time left until `fireAtMs` (host epoch), e.g. "1h 23m", "4m 05s", "12s". */
function fmtRemaining(fireAtMs: number): string {
  const total = Math.max(0, Math.round((fireAtMs - Date.now()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const AGENT_NAMES: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  aider: "Aider",
  copilot: "Copilot CLI",
  opencode: "opencode",
  cursor: "Cursor Agent",
  amp: "Amp",
  unknown: "AI agent",
};
function agentName(kind: AgentKind): string {
  return AGENT_NAMES[kind] ?? "AI agent";
}
function monStateText(state: string): string {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      return "needs you";
    case "idle":
      return "idle";
    case "finished":
      return "finished";
    case "crashed":
      return "crashed";
    default:
      return "…";
  }
}

/**
 * Screen-region change notifications. User flow:
 *   whip button → dialog (list existing + "Add") → drag/resize a rectangle on the screen →
 *   "Create" sends `watch-add`. The host watches those pixels and fires a notification when
 *   they change (e.g. an AI agent's status icon). Regions are stored host-side; the dialog
 *   reflects the authoritative list from `watchers` messages.
 */
export class RegionWatchers {
  private regions: WatchRegion[] = [];
  private timers: TimerInfo[] = [];
  private monitors: MonitorInfo[] = [];
  private monitorSessions: MonitorSessionInfo[] = [];
  /** Agent kinds with "always alert" mode on (host-persisted); drives the per-kind toggle. */
  private alwaysAgents = new Set<AgentKind>();
  private renderPicker: (() => void) | null = null;
  /** Re-renders the always-on toggle in the open monitor dialog when the host's set changes. */
  private renderAlways: (() => void) | null = null;
  private countdownTimer = 0;
  private readonly overlay: HTMLElement; // dialog
  private readonly list: HTMLElement;
  private readonly permissionRow: HTMLElement; // browser-notification status + enable button
  private selector: HTMLElement | null = null; // the on-screen draggable rectangle

  constructor(
    private readonly root: HTMLElement,
    private readonly conn: ControllerTransport,
    private readonly view: ScreenView,
    private readonly notifications: Notifications,
    private readonly requestNotifications: () => void | Promise<void> = () => {},
    private readonly whipository?: Whipository,
    private readonly lashstash?: LashStash,
  ) {
    this.overlay = el("div", "wd-dialog-overlay hidden");
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    // Whip mark + title, same treatment as the Whipository dialog header.
    const titleWrap = el("div", "wd-dialog-title");
    const mark = document.createElement("img");
    mark.src = whipMark;
    mark.alt = "";
    mark.decoding = "async";
    mark.className = "wd-dialog-title-icon";
    titleWrap.append(mark, el("h2", "", "Auto-Whips"));
    head.append(titleWrap);
    const close = el("button", "wd-dialog-x");
    close.appendChild(icon("x"));
    close.onclick = () => this.close();
    head.appendChild(close);

    const help = el("div", "wd-dialog-help");
    const intro = el("p", "wd-help-intro", "Auto-Whips are a set of features that can whip and monitor agents for you automatically:");
    const ul = el("ul", "wd-help-list");
    const li1 = el("li");
    li1.append(
      el("strong", undefined, "Scheduled work"),
      document.createTextNode(" — after a set time: notify you, click a button, click, type & send a whole prompt, or run a saved multi-step lash from your LashStash (e.g. resume work the moment a session limit resets)."),
    );
    const li2 = el("li");
    li2.append(
      el("strong", undefined, "Alerts"),
      document.createTextNode(" — watch part of the screen and ping you when it changes visually (e.g. your agent finishes)."),
    );
    const li3 = el("li");
    li3.append(
      el("strong", undefined, "AI Monitoring"),
      document.createTextNode(" — pick a running AI session and get pinged the moment the agent stops working (it's waiting on you or has gone idle)."),
    );
    const li4 = el("li");
    li4.append(
      el("strong", undefined, "LashStash"),
      document.createTextNode(
        " — build reusable automations (“lashes”) you can run on demand or from Scheduled work: from simply resuming after a session limit to multi-step click-and-type sequences (handy for test automation and productivity boosts).",
      ),
    );
    ul.append(li1, li2, li3);
    if (this.lashstash) ul.append(li4);
    const note = el(
      "p",
      "wd-help-note",
      "Enable browser notifications to be reminded even when the browser is closed.",
    );
    help.append(intro, ul, note);

    this.permissionRow = el("div", "wd-perm-row");
    this.list = el("div", "wd-watch-list");

    const addSchedule = el("button", "wd-btn wd-go");
    addSchedule.append(icon("clock"), el("span", "wd-btn-label", "Schedule work"));
    addSchedule.onclick = () => this.beginSchedule();

    const add = el("button", "wd-btn wd-go");
    add.append(icon("plus"), el("span", "wd-btn-label", "Add alert"));
    add.onclick = () => this.beginSelection();

    const addMonitor = el("button", "wd-btn wd-go");
    addMonitor.append(icon("activity"), el("span", "wd-btn-label", "Add AI Monitoring"));
    addMonitor.onclick = () => this.beginMonitor();

    const actions = el("div", "wd-dialog-actions wd-actions-stack");
    actions.append(addSchedule, add, addMonitor);

    // LashStash: create & manage reusable multi-step automations. Opens the LashStash browser/editor
    // on top (closing it returns here). Last option, after AI Monitoring.
    if (this.lashstash) {
      const openStash = el("button", "wd-btn wd-go");
      openStash.append(icon("zap"), el("span", "wd-btn-label", "LashStash"));
      openStash.onclick = () => this.lashstash!.open();
      actions.append(openStash);
    }

    card.append(head, help, this.permissionRow, this.list, actions);
    this.overlay.appendChild(card);
    this.root.appendChild(this.overlay);
    this.renderPermission();
    // The host streams discovered AI sessions in reply to a `monitor-scan`; refresh the picker.
    this.conn.on("monitorSessions", (sessions) => {
      this.monitorSessions = sessions;
      this.renderPicker?.();
    });
  }

  setRegions(regions: WatchRegion[]): void {
    this.regions = regions;
    this.renderList();
  }

  setTimers(timers: TimerInfo[]): void {
    this.timers = timers;
    this.renderList();
  }

  setMonitors(monitors: MonitorInfo[]): void {
    this.monitors = monitors;
    this.renderList();
  }

  setAlwaysAgents(agents: AgentKind[]): void {
    this.alwaysAgents = new Set(agents);
    this.renderAlways?.(); // reflect the change in the open monitor dialog, if any
  }

  open(): void {
    this.renderPermission();
    this.renderList();
    this.overlay.classList.remove("hidden");
    window.clearInterval(this.countdownTimer);
    // Keep the timer countdowns ticking while the dialog is open.
    this.countdownTimer = window.setInterval(() => {
      if (this.timers.length) this.renderList();
    }, 1000);
  }
  close(): void {
    this.overlay.classList.add("hidden");
    window.clearInterval(this.countdownTimer);
    this.countdownTimer = 0;
  }

  /** Show whether browser notifications are granted; offer a button to request them. */
  private renderPermission(): void {
    this.permissionRow.replaceChildren();
    const dot = el("span", "wd-perm-dot");
    const text = el("span", "wd-perm-text");
    const perm = this.notifications.permission;
    if (perm === "granted") {
      dot.dataset.state = "on";
      text.textContent = "Browser notifications are on.";
      this.permissionRow.append(dot, text);
    } else if (perm === "denied") {
      dot.dataset.state = "off";
      text.textContent = "Notifications are blocked \u2014 enable them in your browser settings.";
      this.permissionRow.append(dot, text);
    } else if (perm === "unsupported") {
      dot.dataset.state = "off";
      text.textContent = "This browser can't show notifications. Keep this page open for in-app alerts.";
      this.permissionRow.append(dot, text);
    } else {
      dot.dataset.state = "warn";
      text.textContent = "Allow notifications to be alerted while this page is in the background.";
      const enable = el("button", "wd-btn wd-perm-enable");
      enable.append(el("span", "wd-btn-label", "Enable"));
      enable.onclick = async () => {
        await this.requestNotifications();
        this.renderPermission();
      };
      this.permissionRow.append(dot, text, enable);
    }
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.regions.length === 0 && this.timers.length === 0 && this.monitors.length === 0) {
      this.list.appendChild(el("p", "wd-dialog-help", "No scheduled work, alerts, or AI monitors yet."));
      return;
    }
    // Same order as the help list + buttons: scheduled work, alerts, AI monitors.
    for (const t of this.timers) {
      const row = el("div", "wd-watch-row");
      const info = el("div", "wd-timer-info");
      const name = el("span", "wd-timer-name");
      name.append(icon("clock", 15), document.createTextNode(t.label));
      const remain = el("span", "wd-timer-remain", fmtRemaining(t.fireAtMs));
      info.append(name, remain);
      row.appendChild(info);
      if (t.hasAction) row.appendChild(el("span", "wd-timer-tag", "auto"));
      const del = el("button", "wd-btn wd-icon-only");
      del.appendChild(icon("trash"));
      del.setAttribute("aria-label", `Cancel ${t.label}`);
      del.onclick = () => {
        this.conn.send({ type: "timer-remove", id: t.id });
        // Optimistic: drop it now so Cancel works instantly even if the host's echo lags.
        this.timers = this.timers.filter((x) => x.id !== t.id);
        this.renderList();
      };
      row.appendChild(del);
      this.list.appendChild(row);
    }
    for (const r of this.regions) {
      const row = el("div", "wd-watch-row");
      const name = el("button", "wd-watch-name", r.label);
      name.title = "Edit this alert";
      name.onclick = () => this.beginSelection(r);
      row.appendChild(name);
      const del = el("button", "wd-btn wd-icon-only");
      del.appendChild(icon("trash"));
      del.setAttribute("aria-label", `Remove ${r.label}`);
      del.onclick = () => {
        this.conn.send({ type: "watch-remove", id: r.id });
        // Optimistic: drop it now so the button feels instant; the host's broadcast reconciles.
        this.regions = this.regions.filter((x) => x.id !== r.id);
        this.renderList();
      };
      row.appendChild(del);
      this.list.appendChild(row);
    }
    for (const m of this.monitors) {
      const row = el("div", "wd-watch-row");
      const info = el("div", "wd-timer-info");
      const name = el("span", "wd-timer-name");
      name.append(icon("activity", 15), document.createTextNode(`${agentName(m.agent)} · ${m.label}`));
      const badge = el("span", "wd-mon-state");
      badge.dataset.state = m.live ? m.state : "finished";
      badge.textContent = m.live ? monStateText(m.state) : "ended";
      info.append(name, badge);
      row.appendChild(info);
      const del = el("button", "wd-btn wd-icon-only");
      del.appendChild(icon("trash"));
      del.setAttribute("aria-label", `Stop monitoring ${m.label}`);
      del.onclick = () => {
        this.conn.send({ type: "monitor-remove", id: m.id });
        // Optimistic: drop it now; the host's `monitors` broadcast reconciles.
        this.monitors = this.monitors.filter((x) => x.id !== m.id);
        this.renderList();
      };
      row.appendChild(del);
      this.list.appendChild(row);
    }
  }

  /** Show the draggable/resizable rectangle + a Create/Cancel bar. Pass a region to edit it. */
  private beginSelection(existing?: WatchRegion): void {
    this.close();
    if (this.selector) this.selector.remove();

    const rect = this.root.getBoundingClientRect();
    // Edit: place the box over the existing region; new: a centered box ~40% of the viewport.
    const box = existing
      ? this.boxFromRegion(existing, rect)
      : { x: rect.width * 0.3, y: rect.height * 0.3, w: rect.width * 0.4, h: rect.height * 0.25 };

    // Non-intrusive explainer so it's clear this isn't free-drawing: the agent watches these
    // pixels and sends a browser notification when they change.
    const info = el(
      "div",
      "wd-selector-info",
      existing
        ? "Move or resize the area to watch, then Save \u2014 you'll be alerted when its pixels change."
        : "You'll get a browser notification when the pixels inside this box change. The agent watches this part of the screen.",
    );

    const sel = el("div", "wd-selector");
    const move = el("div", "wd-selector-move");
    move.appendChild(icon("drag"));
    const handle = el("div", "wd-selector-handle"); // bottom-right resize
    const bar = el("div", "wd-selector-bar");
    const create = el("button", "wd-btn wd-go");
    create.append(el("span", "wd-btn-label", existing ? "Save" : "Create"));
    const cancel = el("button", "wd-btn");
    cancel.append(el("span", "wd-btn-label", "Cancel"));
    bar.append(cancel, create);
    sel.append(move, handle, bar);
    this.root.append(info, sel);
    this.selector = sel;

    const cleanup = () => {
      sel.remove();
      info.remove();
      this.selector = null;
      this.open(); // return to the Alerts list
    };

    const apply = () => {
      sel.style.left = `${box.x}px`;
      sel.style.top = `${box.y}px`;
      sel.style.width = `${box.w}px`;
      sel.style.height = `${box.h}px`;
    };
    apply();

    const dragWith = (target: HTMLElement, onMove: (dx: number, dy: number) => void) => {
      target.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        target.setPointerCapture(e.pointerId);
        let px = e.clientX;
        let py = e.clientY;
        const mv = (ev: PointerEvent) => {
          onMove(ev.clientX - px, ev.clientY - py);
          px = ev.clientX;
          py = ev.clientY;
          apply();
        };
        const up = () => {
          target.removeEventListener("pointermove", mv);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", mv);
        target.addEventListener("pointerup", up);
      });
    };

    dragWith(move, (dx, dy) => {
      box.x = Math.max(0, Math.min(rect.width - box.w, box.x + dx));
      box.y = Math.max(0, Math.min(rect.height - box.h, box.y + dy));
    });
    dragWith(handle, (dx, dy) => {
      box.w = Math.max(40, Math.min(rect.width - box.x, box.w + dx));
      box.h = Math.max(40, Math.min(rect.height - box.y, box.h + dy));
    });

    cancel.onclick = cleanup;
    create.onclick = () => {
      const region = this.toScreenRegion(box, existing);
      if (region) {
        this.conn.send({ type: "watch-add", region });
        // Optimistic: show it at once; the authoritative `watchers` broadcast reconciles (the
        // round-trip can lag over a relay, which used to make it look like nothing happened).
        this.regions = existing
          ? this.regions.map((r) => (r.id === region.id ? region : r))
          : [...this.regions, region];
        if (this.notifications.permission === "default") void this.requestNotifications();
        this.notifications.flash(
          existing ? "Alert updated" : "Alert created",
          existing
            ? `"${region.label}" updated.`
            : `Monitoring "${region.label}". We'll notify you when it changes.`,
          "success",
        );
      }
      cleanup();
    };
  }

  /** Place the editing box over an existing region using the current view transform. */
  private boxFromRegion(
    r: WatchRegion,
    rect: DOMRect,
  ): { x: number; y: number; w: number; h: number } {
    const tl = this.view.normToCanvas(r.x, r.y);
    const br = this.view.normToCanvas(r.x + r.w, r.y + r.h);
    const w = Math.max(40, br.cx - tl.cx);
    const h = Math.max(40, br.cy - tl.cy);
    return {
      x: Math.max(0, Math.min(rect.width - w, tl.cx)),
      y: Math.max(0, Math.min(rect.height - h, tl.cy)),
      w,
      h,
    };
  }

  /** Convert a viewport rectangle (CSS px) to a normalized region of the desktop. */
  private toScreenRegion(
    box: { x: number; y: number; w: number; h: number },
    existing?: WatchRegion,
  ): WatchRegion | null {
    const tl = this.view.canvasToNorm(box.x, box.y);
    const br = this.view.canvasToNorm(box.x + box.w, box.y + box.h);
    const x = Math.min(tl.nx, br.nx);
    const y = Math.min(tl.ny, br.ny);
    const w = Math.abs(br.nx - tl.nx);
    const h = Math.abs(br.ny - tl.ny);
    if (w < 0.005 || h < 0.005) return null;
    // Reuse the id when editing so the host updates the region in place; name new alerts by time.
    return { id: existing?.id ?? uid(), label: existing?.label ?? defaultAlertName(), x, y, w, h };
  }

  /**
   * Schedule work: one thing the host does automatically after a set time. Four rungs, simplest
   * first — send a notification, click a button, click + press Enter, or click + type & send a
   * whole prompt. Built for AI session cooldowns: schedule the click or the next prompt now, and
   * it happens the moment Claude/Copilot frees up.
   */
  private beginSchedule(): void {
    this.close();

    const overlay = el("div", "wd-dialog-overlay");
    const dismiss = () => {
      overlay.remove();
      this.open(); // back to the Auto-Whips list
    };
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) dismiss();
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    head.append(el("h2", "", "Schedule work"));
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = dismiss;
    head.appendChild(x);

    const help = el(
      "p",
      "wd-dialog-help",
      "Have this machine do something for you after a set time — from a simple notification to clicking a button or typing & sending a whole prompt. Waiting out a session limit? Schedule the retry click or the next prompt now, and it runs the moment the cooldown ends.",
    );

    const durRow = el("div", "wd-form-row");
    durRow.appendChild(el("label", "wd-form-label", "Run in"));

    const hours = el("input", "wd-input wd-input-num");
    hours.type = "number";
    hours.min = "0";
    hours.max = "168";
    hours.value = "0";
    hours.inputMode = "numeric";
    const mins = el("input", "wd-input wd-input-num");
    mins.type = "number";
    mins.min = "0";
    mins.max = "59";
    mins.value = "30";
    mins.inputMode = "numeric";

    // Quick presets (common AI session cooldowns) — tap to set; the steppers fine-tune.
    const presets = el("div", "wd-preset-row");
    for (const [plabel, ph, pm] of [
      ["15m", 0, 15],
      ["30m", 0, 30],
      ["1h", 1, 0],
      ["2h", 2, 0],
      ["5h", 5, 0],
    ] as const) {
      const chip = el("button", "wd-preset", plabel);
      chip.type = "button";
      chip.onclick = () => {
        hours.value = String(ph);
        mins.value = String(pm);
      };
      presets.appendChild(chip);
    }

    // − / + steppers around each field for easy thumb adjustment on mobile.
    const stepper = (input: HTMLInputElement, step: number, max: number, unit: string) => {
      const wrap = el("div", "wd-stepper");
      const minus = el("button", "wd-step-btn", "\u2212");
      minus.type = "button";
      const plus = el("button", "wd-step-btn", "+");
      plus.type = "button";
      const clampVal = (v: number) => Math.max(0, Math.min(max, v));
      minus.onclick = () => (input.value = String(clampVal((Number(input.value) || 0) - step)));
      plus.onclick = () => (input.value = String(clampVal((Number(input.value) || 0) + step)));
      wrap.append(minus, input, el("span", "wd-form-unit", unit), plus);
      return wrap;
    };
    const durFields = el("div", "wd-form-duration");
    durFields.append(stepper(hours, 1, 168, "h"), stepper(mins, 5, 59, "m"));

    durRow.append(presets, durFields);

    const labelRow = el("div", "wd-form-row");
    labelRow.appendChild(el("label", "wd-form-label", "Label"));
    const label = el("input", "wd-input");
    label.placeholder = "e.g. Claude is back";
    labelRow.appendChild(label);

    const actRow = el("div", "wd-form-row");
    actRow.appendChild(el("label", "wd-form-label", "What to do"));
    const actPick = el("div", "wd-lash-pickrow");
    const sel = el("select", "wd-input");
    for (const [value, text] of [
      ["none", "Send me a notification"],
      ["click", "Click a button"],
      ["key", "Click to focus & press Enter"],
      ["text", "Click to focus, type & press Enter"],
      ["lash", "Custom — run a saved lash (multi-step)"],
    ] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    }
    actPick.appendChild(sel);

    // The square LashStash button beside the dropdown: browse/record reusable multi-step
    // automations ("lashes") and pick one to schedule — no re-placing targets every time.
    let pickedLash: Lash | null = null;
    const pickedStatus = el("p", "wd-form-target-status hidden");
    const syncPicked = () => {
      pickedStatus.classList.toggle("hidden", sel.value !== "lash");
      if (sel.value !== "lash") return;
      if (pickedLash) {
        const n = pickedLash.steps.length;
        pickedStatus.textContent = `Lash: “${pickedLash.name}” (${n} step${n === 1 ? "" : "s"})`;
        pickedStatus.classList.add("set");
      } else {
        pickedStatus.textContent = "No lash picked yet — tap the LashStash button.";
        pickedStatus.classList.remove("set");
      }
    };
    const openStash = () => {
      overlay.style.display = "none"; // the stash replaces this form until picked/closed
      this.lashstash!.open({
        onPick: (lash) => {
          pickedLash = lash;
          sel.value = "lash";
          overlay.style.display = "";
          syncPicked();
          syncNext();
        },
        // A lash was executed from the stash: drop this form entirely (all dialogs close, the
        // countdown card takes over). Otherwise just come back to the form.
        onDone: (executed) => {
          if (executed) overlay.remove();
          else overlay.style.display = "";
        },
      });
    };
    if (this.lashstash) {
      const stashBtn = el("button", "wd-btn wd-icon-only wd-lash-btn");
      stashBtn.type = "button";
      stashBtn.title = "LashStash — your saved automations";
      stashBtn.setAttribute("aria-label", "Open LashStash");
      stashBtn.appendChild(icon("zap"));
      stashBtn.onclick = openStash;
      actPick.appendChild(stashBtn);
    }
    actRow.append(actPick, pickedStatus);

    const bar = el("div", "wd-dialog-actions");
    const cancel = el("button", "wd-btn");
    cancel.append(el("span", "wd-btn-label", "Cancel"));
    cancel.onclick = dismiss;
    const next = el("button", "wd-btn wd-go");
    const nextLabel = el("span", "wd-btn-label", "Schedule");
    next.append(icon("clock"), nextLabel);
    const syncNext = () => {
      nextLabel.textContent =
        sel.value === "none" || (sel.value === "lash" && pickedLash)
          ? "Schedule"
          : sel.value === "lash"
            ? "Next: pick a lash"
            : "Next: place target";
    };
    sel.onchange = () => {
      syncPicked();
      syncNext();
    };
    syncNext();

    const durationMs = (): number | null => {
      const h = Math.max(0, Math.min(168, Math.round(Number(hours.value) || 0)));
      const m = Math.max(0, Math.min(59, Math.round(Number(mins.value) || 0)));
      const ms = (h * 60 + m) * 60_000;
      return ms >= 60_000 ? ms : null;
    };
    const spanText = (): string => {
      const h = Math.max(0, Math.round(Number(hours.value) || 0));
      const m = Math.max(0, Math.round(Number(mins.value) || 0));
      return `${h ? `${h}h ` : ""}${m}m`;
    };
    const startTimer = (action: ScheduledAction | undefined, defaultLabel?: string) => {
      const id = uid();
      const fireInMs = durationMs()!;
      const lbl = label.value.trim() || defaultLabel || `Scheduled work (${spanText()})`;
      this.conn.send({ type: "timer-add", id, fireInMs, label: lbl, action });
      // Optimistic: show it at once; the authoritative `timers` broadcast reconciles.
      this.timers = [...this.timers, { id, label: lbl, fireAtMs: Date.now() + fireInMs, hasAction: !!action }];
      if (this.notifications.permission === "default") void this.requestNotifications();
      this.notifications.flash(
        "Work scheduled",
        `"${lbl}" — ${action ? "runs" : "I'll ping you"} in ${spanText()}.`,
        "success",
      );
      dismiss();
    };

    next.onclick = () => {
      if (durationMs() == null) {
        this.notifications.flash("Set a time", "Choose at least 1 minute.", "warning");
        return;
      }
      const kind = sel.value as "none" | "click" | "key" | "text" | "lash";
      if (kind === "none") {
        startTimer(undefined);
        return;
      }
      if (kind === "lash") {
        if (!this.lashstash) return;
        if (!pickedLash) {
          openStash(); // pick (or record) one first; scheduling resumes back on this form
          return;
        }
        // Snapshot the steps: later edits/deletes of the saved lash must not change what fires.
        startTimer({ kind: "steps", steps: pickedLash.steps, displayId: pickedLash.displayId }, pickedLash.name);
        return;
      }
      // Hand off to the live-screen placement mode (and prompt entry, for "text").
      overlay.style.display = "none";
      const hint =
        kind === "text"
          ? "Drag the crosshair onto the target input and type your prompt. When time's up it will be clicked to focus, the text inserted, and Enter pressed."
          : kind === "key"
            ? "Drag the crosshair onto the field. When time's up it will be clicked to focus and Enter pressed."
            : "Drag the crosshair onto the button or UI. It will be clicked when time's up.";
      placeTarget(
        this.view,
        this.root,
        { withText: kind === "text", hint, confirmLabel: "Confirm target", whipository: this.whipository },
        (result) => {
          if (!result) {
            overlay.style.display = ""; // placement cancelled -> back to the form
            return;
          }
          let action: ScheduledAction;
          if (kind === "click") action = { kind: "click", x: result.nx, y: result.ny, button: "left" };
          else if (kind === "key") action = { kind: "key", key: "Enter", x: result.nx, y: result.ny };
          else action = { kind: "text", text: result.text ?? "", x: result.nx, y: result.ny };
          startTimer(action);
        },
      );
    };
    bar.append(cancel, next);

    card.append(head, help, durRow, labelRow, actRow, bar);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
  }

  /**
   * Monitor a running AI session (Claude Code, Codex, Gemini, Aider, …). Zero-config: the host
   * discovers sessions by observing processes — nothing to install or launch differently. Pick one
   * to get pinged when it stops working, or flip "always alert" on for the whole agent kind.
   */
  private beginMonitor(): void {
    this.close();

    const overlay = el("div", "wd-dialog-overlay");
    const dismiss = () => {
      this.renderPicker = null;
      this.renderAlways = null;
      overlay.remove();
      this.open(); // back to the Auto-Whips list
    };
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) dismiss();
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    head.append(el("h2", "", "Monitor an AI session"));
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = dismiss;
    head.appendChild(x);

    const help = el(
      "p",
      "wd-dialog-help",
      "Pick a running AI session to watch. WhipDesk finds AI sessions automatically — no setup, no wrappers. You'll get one ping the moment the AI session stops working (it's waiting on you or has gone idle).",
    );

    const pickHead = el("div", "wd-mon-pick-head");
    const rescan = el("button", "wd-btn");
    rescan.append(el("span", "wd-btn-label", "Rescan"));
    rescan.onclick = () => this.conn.send({ type: "monitor-scan" });
    pickHead.append(el("span", "wd-form-label", "Running AI sessions"), rescan);

    const listWrap = el("div", "wd-mon-pick");
    let selectedKey = "";

    const renderSessions = () => {
      listWrap.replaceChildren();
      if (this.monitorSessions.length === 0) {
        selectedKey = "";
        syncAdd();
        renderAlways();
        listWrap.appendChild(
          el("p", "wd-dialog-help", "No AI sessions detected yet. Start Claude Code, Codex, Gemini, or Aider, then Rescan."),
        );
        return;
      }
      // Auto-select the first session so "Add monitor" works without an extra tap. Also recovers
      // the selection if a rescan dropped the previously highlighted session.
      if (!selectedKey || !this.monitorSessions.some((s) => s.key === selectedKey)) {
        selectedKey = this.monitorSessions[0]!.key;
      }
      for (const s of this.monitorSessions) {
        const item = el("button", "wd-mon-item");
        item.type = "button";
        if (s.key === selectedKey) item.classList.add("on");
        const main = el("div", "wd-mon-item-main");
        main.append(icon("activity", 15), el("span", "wd-mon-item-title", `${agentName(s.agent)} · ${s.title}`));
        const badge = el("span", "wd-mon-state");
        badge.dataset.state = s.state;
        badge.textContent = monStateText(s.state);
        item.append(main, badge);
        item.onclick = () => {
          selectedKey = s.key;
          renderSessions();
        };
        listWrap.appendChild(item);
      }
      syncAdd();
      renderAlways();
    };
    this.renderPicker = renderSessions;

    // "Always alert" is per agent KIND, controlled here where the agent is chosen. It's bound to the
    // selected session's kind and persists host-side, so it keeps alerting across restarts.
    const alwaysRow = el("div", "wd-form-row");
    alwaysRow.appendChild(el("label", "wd-form-label", "Always alert me"));
    const alwaysWrap = el("div", "wd-mon-always");
    alwaysRow.appendChild(alwaysWrap);
    const renderAlways = () => {
      alwaysWrap.replaceChildren();
      const session = this.monitorSessions.find((s) => s.key === selectedKey);
      if (!session) {
        alwaysWrap.appendChild(el("p", "wd-dialog-help", "Pick a session above to always alert for its agent."));
        return;
      }
      const kind = session.agent;
      const lab = el("label", "wd-check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = this.alwaysAgents.has(kind);
      cb.onchange = () => {
        // Optimistic; the host echoes `monitor-always-agents` to reconcile.
        if (cb.checked) this.alwaysAgents.add(kind);
        else this.alwaysAgents.delete(kind);
        this.conn.send({ type: "monitor-always", agent: kind, enabled: cb.checked });
        if (cb.checked && this.notifications.permission === "default") void this.requestNotifications();
        renderAlways();
      };
      const txt = el("span", "wd-check-text");
      txt.append(
        document.createTextNode(`Always monitor every ${agentName(kind)} session`),
        el("span", "wd-check-sub", "Keeps alerting across agent and WhipDesk restarts — no need to re-add it."),
      );
      lab.append(cb, txt);
      alwaysWrap.appendChild(lab);
    };
    this.renderAlways = renderAlways;

    const bar = el("div", "wd-dialog-actions");
    const cancel = el("button", "wd-btn");
    cancel.append(el("span", "wd-btn-label", "Cancel"));
    cancel.onclick = dismiss;
    const add = el("button", "wd-btn wd-go");
    add.append(icon("activity"), el("span", "wd-btn-label", "Add monitor"));
    const syncAdd = () => (add.disabled = !selectedKey);
    syncAdd();
    add.onclick = () => {
      const session = this.monitorSessions.find((s) => s.key === selectedKey);
      if (!session) return;
      const id = uid();
      const label = session.title;
      this.conn.send({ type: "monitor-add", id, key: session.key, agent: session.agent, label });
      // Optimistic: show it at once; the host's `monitors` broadcast reconciles.
      this.monitors = [
        ...this.monitors,
        { id, key: session.key, agent: session.agent, label, state: session.state, live: true },
      ];
      if (this.notifications.permission === "default") void this.requestNotifications();
      this.notifications.flash("Monitoring started", `Watching ${agentName(session.agent)} · ${label}.`, "success");
      dismiss();
    };
    bar.append(cancel, add);

    // Honest fine print: detection is heuristic (processes + transcripts across many AI tools and
    // setups), so it can miss a session — own that, and point people at the repo to report or fix.
    const caveat = el("p", "wd-mon-caveat");
    const gh = document.createElement("a");
    gh.href = GITHUB_URL;
    gh.target = "_blank";
    gh.rel = "noopener noreferrer";
    gh.textContent = "report it as a GitHub issue";
    caveat.append(
      document.createTextNode(
        "* Due to the variety of AI sessions and setups, this sometimes doesn't detect every AI session. Please ",
      ),
      gh,
      document.createTextNode(" — or even better, submit a PR with a fix."),
    );

    card.append(head, help, pickHead, listWrap, alwaysRow, caveat, bar);
    overlay.appendChild(card);
    this.root.appendChild(overlay);

    renderSessions();
    this.conn.send({ type: "monitor-scan" }); // ask the host to discover sessions right now
  }
}
