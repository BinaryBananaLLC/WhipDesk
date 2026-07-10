import { LASH_LIMITS, type DisplayInfo, type Lash, type LashStep, type ScreenInfo } from "@whipdesk/protocol";
import type { ControllerTransport } from "./core";
import type { Notifications } from "./notifications";
import type { ScreenView } from "./screen";
import type { Whipository } from "./whipository";
import { icon } from "./icons";
import { placeTarget } from "./placement";
import whipositoryMark from "./assets/whipository.png";
import lashStashIcon from "./assets/lash-stash-icon.png";

/**
 * The LashStash — the drawer where you keep your pre-recorded "lashes": named, reusable input
 * automations ("click 812,445 → type 'fix it' → Enter") to deploy against an AI session without
 * re-placing the target every time. Opened from the square button next to "What to do" in the
 * Schedule-work form: pick a lash to schedule it, or Execute one right now (3s countdown).
 *
 * Storage model: lashes live ON THE HOST (state dir, like timers) because their coordinates are
 * tied to that machine's screens — they survive agent updates, are never synced to the cloud, and
 * are allowed to fail loudly when displays/windows changed since recording. This dialog is a thin
 * editor over the host's authoritative list (`lashes` broadcasts), with optimistic local updates.
 */

/** Grace period before an immediate "Execute" fires — long enough to cancel a fat-finger. */
const EXEC_COUNTDOWN_MS = 3000;

/** Keys offered by the "Press key" step editor (names the input backends understand). */
const STEP_KEYS = ["Enter", "Escape", "Tab", "Space", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"] as const;

let counter = 0;
function uid(): string {
  return `l${Date.now().toString(36)}${(counter++).toString(36)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Default lash name: the moment it was created, e.g. "Lash Jun 25, 02:32 PM". */
function defaultName(): string {
  return `Lash ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/** Human description of one step; px coords use the screen size the lash was RECORDED on. */
export function describeStep(step: LashStep, screen?: ScreenInfo): string {
  switch (step.kind) {
    case "click": {
      const at =
        screen && screen.width > 0
          ? `${Math.round((step.x ?? 0) * screen.width)}, ${Math.round((step.y ?? 0) * screen.height)} px`
          : `${Math.round((step.x ?? 0) * 100)}%, ${Math.round((step.y ?? 0) * 100)}%`;
      const btn = step.button && step.button !== "left" ? ` (${step.button})` : "";
      return `${step.double ? "Double-click" : "Click"} at ${at}${btn}`;
    }
    case "text": {
      const t = (step.text ?? "").replace(/\s+/g, " ").trim();
      const teaser = t.length > 36 ? `${t.slice(0, 36)}…` : t;
      return `Type “${teaser}”${step.submit !== false ? " + Enter" : ""}`;
    }
    case "key":
      return `Press ${[...(step.modifiers ?? []), step.key ?? "?"].join("+")}`;
    case "wait": {
      const s = (step.ms ?? 0) / 1000;
      return `Wait ${s >= 1 && Number.isInteger(s) ? s.toFixed(0) : s.toFixed(1)}s`;
    }
    case "display":
      return `Switch to ${step.displayName ?? `display ${step.displayId ?? "?"}`}`;
    default:
      return "Unknown step";
  }
}

/** One-line teaser for a lash row: step count + the first step. */
function lashSummary(lash: Lash): string {
  const first = lash.steps[0];
  const n = lash.steps.length;
  return `${n} step${n === 1 ? "" : "s"}${first ? ` · ${describeStep(first, lash.screen)}` : ""}`;
}

export interface LashStashOpenOptions {
  /** Enables pick mode: each lash gets a "use" button; choosing one closes the dialog. */
  onPick?: (lash: Lash) => void;
  /** Fired once when the dialog closes any other way. `executed` = an Execute countdown started
   * (the caller should drop its own dialogs too, not restore them). */
  onDone?: (executed: boolean) => void;
}

export class LashStash {
  private lashes: Lash[] = [];
  /** Display the host is currently capturing — new click steps are recorded against it. */
  private activeDisplay = 0;
  /** All host displays — offered by the "Change monitor" step so a lash can span screens. */
  private displays: DisplayInfo[] = [];
  private overlay: HTMLElement | null = null;
  private opts: LashStashOpenOptions = {};
  /** Re-renders the open list view when the host's broadcast reconciles our optimistic state. */
  private refreshList: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly conn: ControllerTransport,
    private readonly view: ScreenView,
    private readonly notifications: Notifications,
    private readonly whipository?: Whipository,
  ) {}

  /** The host's authoritative list (from `welcome` + `lashes` broadcasts). */
  setLashes(lashes: Lash[]): void {
    this.lashes = lashes;
    this.refreshList?.();
  }

  setActiveDisplay(id: number): void {
    this.activeDisplay = id;
  }

  setDisplays(displays: DisplayInfo[]): void {
    this.displays = displays;
  }

  open(opts: LashStashOpenOptions = {}): void {
    this.teardown();
    this.opts = opts;

    // wd-whips-overlay lifts it above the placement layer, like the Whipository dialog.
    const overlay = el("div", "wd-dialog-overlay wd-whips-overlay");
    this.overlay = overlay;
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) this.close();
    });
    const card = el("div", "wd-dialog");

    const head = el("div", "wd-dialog-head");
    const titleWrap = el("div", "wd-dialog-title");
    const mark = document.createElement("img");
    mark.src = lashStashIcon;
    mark.alt = "";
    mark.decoding = "async";
    mark.className = "wd-dialog-title-icon";
    titleWrap.append(mark, el("h2", "", "LashStash"));
    const headActions = el("div", "wd-dialog-head-actions");
    const add = el("button", "wd-btn wd-icon-only wd-whips-add");
    add.appendChild(icon("plus"));
    add.setAttribute("aria-label", "Add lash");
    add.title = "Record a new lash";
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = () => this.close();
    headActions.append(add, x);
    head.append(titleWrap, headActions);

    const help = el("p", "wd-dialog-help");
    const body = el("div", "wd-lash-body");
    // Honest one-liner about where lashes live (deliberately NOT synced — see module docs).
    const where = el(
      "p",
      "wd-whips-where",
      "Lashes are stored on this machine only — they're tied to its screens and survive updates.",
    );

    card.append(head, help, body, where);
    overlay.appendChild(card);
    this.root.appendChild(overlay);

    // ---- list view -----------------------------------------------------------
    const renderList = () => {
      help.textContent = this.opts.onPick
        ? "Your saved automations. Pick one for this scheduled work, or run one right now."
        : "Your saved automations (lashes). Record once, reuse forever — or run one right now.";
      add.classList.remove("hidden");
      body.replaceChildren();
      if (this.lashes.length === 0) {
        body.appendChild(el("p", "wd-dialog-help", "No lashes yet — tap + to record the clicks and prompts you keep redoing."));
        return;
      }
      for (const lash of this.lashes) {
        const row = el("div", "wd-whip-row");
        const main = el("button", "wd-lash-main");
        main.type = "button";
        main.title = "View steps";
        main.append(el("span", "wd-lash-title", lash.name), el("span", "wd-lash-sub", lashSummary(lash)));
        main.onclick = () => renderDetail(lash);
        row.appendChild(main);
        if (this.opts.onPick) {
          const use = el("button", "wd-btn wd-icon-only");
          use.appendChild(icon("insert"));
          use.setAttribute("aria-label", `Use ${lash.name}`);
          use.title = "Use for this scheduled work";
          use.onclick = () => this.pickClose(lash);
          row.appendChild(use);
        } else {
          const run = el("button", "wd-btn wd-icon-only");
          run.appendChild(icon("play"));
          run.setAttribute("aria-label", `Execute ${lash.name}`);
          run.title = "Execute now";
          run.onclick = () => this.execute(lash);
          row.appendChild(run);
        }
        const edit = el("button", "wd-btn wd-icon-only");
        edit.appendChild(icon("pencil"));
        edit.setAttribute("aria-label", `Edit ${lash.name}`);
        edit.title = "Edit";
        edit.onclick = () => renderEditor(lash);
        const del = el("button", "wd-btn wd-icon-only");
        del.appendChild(icon("trash"));
        del.setAttribute("aria-label", `Delete ${lash.name}`);
        del.title = "Delete";
        del.onclick = () => confirmDelete(row, lash);
        row.append(edit, del);
        body.appendChild(row);
      }
    };
    this.refreshList = renderList;

    // Inline delete confirmation (installed PWAs block window.confirm — same as the Whipository).
    const confirmDelete = (row: HTMLElement, lash: Lash) => {
      const restore = [...row.children];
      row.replaceChildren();
      const ask = el("span", "wd-whip-confirm", "Delete this lash?");
      const cancel = el("button", "wd-btn wd-whip-confirm-btn");
      cancel.append(el("span", "wd-btn-label", "Cancel"));
      cancel.onclick = () => row.replaceChildren(...restore);
      const yes = el("button", "wd-btn wd-danger wd-whip-confirm-btn");
      yes.append(el("span", "wd-btn-label", "Delete"));
      yes.onclick = () => {
        this.conn.send({ type: "lash-remove", id: lash.id });
        // Optimistic: drop it now; the host's `lashes` broadcast reconciles.
        this.lashes = this.lashes.filter((l) => l.id !== lash.id);
        renderList();
      };
      row.append(ask, cancel, yes);
    };

    // ---- detail view (the step list — "what does this lash actually do?") -----
    const renderDetail = (lash: Lash) => {
      help.textContent = lash.name;
      add.classList.add("hidden");
      body.replaceChildren();
      const steps = el("div", "wd-lash-steps");
      lash.steps.forEach((s, i) => {
        const row = el("div", "wd-lash-step");
        row.append(el("span", "wd-lash-step-num", String(i + 1)), el("span", "wd-lash-step-desc", describeStep(s, lash.screen)));
        steps.appendChild(row);
      });
      body.appendChild(steps);
      const bar = el("div", "wd-dialog-actions");
      const back = el("button", "wd-btn");
      back.append(el("span", "wd-btn-label", "Back"));
      back.onclick = renderList;
      bar.appendChild(back);
      if (this.opts.onPick) {
        const use = el("button", "wd-btn wd-go");
        use.append(icon("insert"), el("span", "wd-btn-label", "Use"));
        use.onclick = () => this.pickClose(lash);
        bar.appendChild(use);
      }
      const run = el("button", "wd-btn wd-go");
      run.append(icon("play"), el("span", "wd-btn-label", "Execute"));
      run.onclick = () => this.execute(lash);
      bar.appendChild(run);
      body.appendChild(bar);
    };

    // ---- editor (record a new lash / edit an existing one) --------------------
    const renderEditor = (existing: Lash | null) => {
      if (!existing && this.lashes.length >= LASH_LIMITS.MAX_LASHES) {
        this.notifications.flash("LashStash is full", `Keep it under ${LASH_LIMITS.MAX_LASHES} lashes — delete one first.`, "warning");
        return;
      }
      help.textContent = existing
        ? "Adjust the steps — they run top to bottom."
        : "Build the steps this lash performs, top to bottom. Simple presets or a fully custom sequence.";
      add.classList.add("hidden");
      const draft = {
        name: existing?.name ?? "",
        steps: existing ? existing.steps.map((s) => ({ ...s })) : ([] as LashStep[]),
        displayId: existing?.displayId ?? this.activeDisplay,
        screen: existing?.screen ?? this.view.getScreen(),
      };
      body.replaceChildren();

      const nameRow = el("div", "wd-form-row");
      nameRow.appendChild(el("label", "wd-form-label", "Name"));
      const name = el("input", "wd-input");
      name.maxLength = LASH_LIMITS.MAX_NAME;
      name.placeholder = "e.g. Resume Claude after limit";
      name.value = draft.name;
      nameRow.appendChild(name);

      // Declared here (not in the palette section below) so the insert-hint can scroll it into view.
      const chips = el("div", "wd-preset-row wd-lash-chips");

      // insertAt = where the NEXT added step(s) land. null = append to the end (the default). A step
      // row's "insert" button arms a ONE-SHOT mid-list insert, so a forgotten Wait can drop between
      // two clicks without rebuilding the whole lash.
      let insertAt: number | null = null;
      const stepsLabel = el("label", "wd-form-label", "Steps");

      const insertHint = el("div", "wd-lash-insert-hint hidden");
      const insertHintText = el("span", "wd-lash-insert-text", "");
      const insertHintCancel = el("button", "wd-btn wd-icon-only wd-lash-insert-x");
      insertHintCancel.appendChild(icon("x", 15));
      insertHintCancel.setAttribute("aria-label", "Cancel inserting — add to the end instead");
      insertHintCancel.title = "Add to the end instead";
      insertHint.append(insertHintText, insertHintCancel);
      const setInsertAt = (at: number | null) => {
        insertAt = at;
        insertHint.classList.toggle("hidden", at === null);
        if (at !== null) {
          insertHintText.textContent =
            at >= draft.steps.length ? "Adding to the end" : `Inserting before step ${at + 1}`;
          // Bring the palette into view so the next tap obviously lands the step at this spot.
          chips.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      };
      insertHintCancel.onclick = () => setInsertAt(null);

      const stepsWrap = el("div", "wd-lash-steps");
      const renderSteps = (flash?: { at: number; count: number }) => {
        stepsLabel.textContent = draft.steps.length ? `Steps (${draft.steps.length})` : "Steps";
        stepsWrap.replaceChildren();
        if (draft.steps.length === 0) {
          stepsWrap.appendChild(el("p", "wd-dialog-help", "No steps yet — add your first step below."));
          return;
        }
        draft.steps.forEach((s, i) => {
          const row = el("div", "wd-lash-step");
          // Brief highlight so a just-added/inserted step visibly "lands" in the list (the palette
          // sits below, so without this an add could look like nothing happened).
          if (flash && i >= flash.at && i < flash.at + flash.count) row.classList.add("wd-lash-step-new");
          row.append(
            el("span", "wd-lash-step-num", String(i + 1)),
            el("span", "wd-lash-step-desc", describeStep(s, draft.screen)),
          );
          const ctl = el("div", "wd-lash-step-ctl");
          const ins = el("button", "wd-btn wd-icon-only");
          ins.appendChild(icon("plus", 16));
          ins.setAttribute("aria-label", `Insert a step after step ${i + 1}`);
          ins.title = "Insert a step after this one";
          ins.onclick = () => setInsertAt(i + 1);
          const up = el("button", "wd-btn wd-icon-only");
          up.appendChild(icon("chevron-up", 16));
          up.setAttribute("aria-label", "Move step up");
          up.disabled = i === 0;
          up.onclick = () => {
            [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i]!, draft.steps[i - 1]!];
            renderSteps();
          };
          const down = el("button", "wd-btn wd-icon-only");
          down.appendChild(icon("chevron-down", 16));
          down.setAttribute("aria-label", "Move step down");
          down.disabled = i === draft.steps.length - 1;
          down.onclick = () => {
            [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i]!, draft.steps[i + 1]!];
            renderSteps();
          };
          const del = el("button", "wd-btn wd-icon-only");
          del.appendChild(icon("trash", 16));
          del.setAttribute("aria-label", "Remove step");
          del.onclick = () => {
            draft.steps.splice(i, 1);
            if (insertAt !== null && insertAt > draft.steps.length) setInsertAt(draft.steps.length);
            renderSteps();
          };
          ctl.append(ins, up, down, del);
          row.appendChild(ctl);
          stepsWrap.appendChild(row);
        });
      };
      renderSteps();

      // Sub-form host: the inline editors for text/key/wait steps render here, one at a time.
      const subform = el("div", "wd-lash-subform");
      const closeSub = () => subform.replaceChildren();

      const pushSteps = (...steps: LashStep[]) => {
        if (draft.steps.length + steps.length > LASH_LIMITS.MAX_STEPS) {
          this.notifications.flash("Too many steps", `A lash can hold up to ${LASH_LIMITS.MAX_STEPS} steps.`, "warning");
          return;
        }
        const at = insertAt ?? draft.steps.length;
        draft.steps.splice(at, 0, ...steps);
        setInsertAt(null); // one-shot: fall back to appending after each add
        renderSteps({ at, count: steps.length });
        // Scroll the freshly added step into view so it's obvious something happened.
        window.setTimeout(
          () => stepsWrap.querySelector(".wd-lash-step-new")?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
          30,
        );
      };

      // Click steps are recorded on the live screen (pan/zoom + crosshair, like timer targets).
      // The dialog hides during placement and comes right back after.
      const place = (withText: boolean, hint: string, done: (r: { nx: number; ny: number; text?: string }) => void) => {
        overlay.style.display = "none";
        placeTarget(
          this.view,
          this.root,
          { withText, hint, confirmLabel: "Add step", whipository: this.whipository },
          (result) => {
            overlay.style.display = "";
            if (!result) return;
            // A multi-monitor lash pins its INITIAL display in draft.displayId and switches later
            // via "display" steps, so only retarget the whole lash while it has no monitor-switch
            // steps yet (older single-display clicks from another display are invalid by design).
            if (!draft.steps.some((s) => s.kind === "display")) draft.displayId = this.activeDisplay;
            draft.screen = this.view.getScreen();
            done(result);
          },
        );
      };

      // Step palette: the same rungs as "What to do" (click / click+Enter / click+type+Enter)
      // plus the raw building blocks for fully custom sequences. (`chips` is declared above so the
      // insert-hint can scroll it into view.)
      const chip = (label: string, onTap: () => void) => {
        const b = el("button", "wd-preset", label);
        b.type = "button";
        b.onclick = () => {
          closeSub();
          onTap();
        };
        chips.appendChild(b);
      };
      chip("+ Click", () =>
        place(false, "Drag the crosshair onto the button or UI to click.", (r) => pushSteps({ kind: "click", x: r.nx, y: r.ny, button: "left" })),
      );
      chip("+ Click & Enter", () =>
        place(false, "Drag the crosshair onto the field — it will be clicked to focus, then Enter pressed.", (r) =>
          pushSteps({ kind: "click", x: r.nx, y: r.ny, button: "left" }, { kind: "key", key: "Enter" }),
        ),
      );
      chip("+ Click, type & Enter", () =>
        place(true, "Drag the crosshair onto the target input and type the prompt. It will be clicked, the text inserted, and Enter pressed.", (r) =>
          pushSteps({ kind: "click", x: r.nx, y: r.ny, button: "left" }, { kind: "text", text: r.text ?? "", submit: true }),
        ),
      );
      chip("+ Type text", () => {
        const ta = el("textarea", "wd-input wd-input-area");
        ta.maxLength = LASH_LIMITS.MAX_TEXT;
        ta.rows = 3;
        ta.placeholder = "Text to type into whatever is focused…";
        const taRow = el("div", "wd-place-text-row");
        taRow.appendChild(ta);
        if (this.whipository) {
          const whips = el("button", "wd-btn wd-icon-only wd-whips-btn");
          whips.type = "button";
          whips.title = "Whipository — insert a saved prompt";
          const whipsImg = document.createElement("img");
          whipsImg.src = whipositoryMark;
          whipsImg.alt = "";
          whipsImg.decoding = "async";
          whips.appendChild(whipsImg);
          whips.onclick = () =>
            this.whipository!.open((text) => {
              ta.value = ta.value ? `${ta.value}${text}` : text;
              ta.focus();
            });
          taRow.appendChild(whips);
        }
        const lab = el("label", "wd-check");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = true;
        lab.append(cb, el("span", "wd-check-text", "Press Enter after (send it)"));
        subform.replaceChildren(taRow, lab, subActions(() => {
          const text = ta.value.trim();
          if (!text) {
            ta.focus();
            return false;
          }
          pushSteps({ kind: "text", text, submit: cb.checked });
          return true;
        }));
        window.setTimeout(() => ta.focus(), 50);
      });
      chip("+ Press key", () => {
        const sel = el("select", "wd-input");
        for (const k of STEP_KEYS) {
          const o = document.createElement("option");
          o.value = k;
          o.textContent = k;
          sel.appendChild(o);
        }
        subform.replaceChildren(sel, subActions(() => {
          pushSteps({ kind: "key", key: sel.value });
          return true;
        }));
      });
      chip("+ Wait", () => {
        const secs = el("input", "wd-input wd-input-num");
        secs.type = "number";
        secs.min = "1";
        secs.max = String(LASH_LIMITS.MAX_WAIT_MS / 1000);
        secs.value = "2";
        secs.inputMode = "numeric";
        const row = el("div", "wd-form-duration");
        row.append(secs, el("span", "wd-form-unit", "seconds"));
        subform.replaceChildren(row, subActions(() => {
          const s = Math.max(1, Math.min(LASH_LIMITS.MAX_WAIT_MS / 1000, Math.round(Number(secs.value) || 0)));
          pushSteps({ kind: "wait", ms: s * 1000 });
          return true;
        }));
      });
      // Multi-monitor lashes: a "change monitor" step switches which screen the FOLLOWING clicks
      // target, so you can "click on monitor 1 → change monitor → click on monitor 2". Only shown
      // when the host actually has more than one display.
      if (this.displays.length > 1) {
        chip("+ Change monitor", () => {
          const sel = el("select", "wd-input");
          for (const d of this.displays) {
            const o = document.createElement("option");
            o.value = String(d.id);
            o.textContent = `${d.name}${d.primary ? " ★" : ""}`;
            if (d.id === this.activeDisplay) o.selected = true;
            sel.appendChild(o);
          }
          const hint = el("p", "wd-dialog-help", "The next click steps target this monitor. The live view switches to it so you can place them.");
          subform.replaceChildren(hint, sel, subActions(() => {
            const id = Number(sel.value);
            const disp = this.displays.find((d) => d.id === id);
            if (!disp) return false;
            // Switch the live stream so the chosen monitor is visible for the clicks that follow.
            this.conn.send({ type: "select-display", id });
            this.activeDisplay = id;
            draft.screen = this.view.getScreen();
            pushSteps({ kind: "display", displayId: id, displayName: disp.name });
            return true;
          }));
        });
      }
      const subActions = (onAdd: () => boolean) => {
        const bar = el("div", "wd-dialog-actions");
        const cancel = el("button", "wd-btn");
        cancel.append(el("span", "wd-btn-label", "Cancel"));
        cancel.onclick = closeSub;
        const ok = el("button", "wd-btn wd-go");
        ok.append(el("span", "wd-btn-label", "Add step"));
        ok.onclick = () => {
          if (onAdd()) closeSub();
        };
        bar.append(cancel, ok);
        return bar;
      };

      const bar = el("div", "wd-dialog-actions");
      const cancel = el("button", "wd-btn");
      cancel.append(el("span", "wd-btn-label", "Cancel"));
      cancel.onclick = renderList;
      const save = el("button", "wd-btn wd-go");
      save.append(el("span", "wd-btn-label", existing ? "Save" : "Create"));
      save.onclick = () => {
        if (draft.steps.length === 0) {
          this.notifications.flash("No steps", "Add at least one step first.", "warning");
          return;
        }
        const lash: Lash = {
          id: existing?.id ?? uid(),
          name: name.value.trim().slice(0, LASH_LIMITS.MAX_NAME) || defaultName(),
          steps: draft.steps,
          displayId: draft.displayId,
          screen: draft.screen,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        this.conn.send({ type: "lash-save", lash });
        // Optimistic: show it at once; the host's `lashes` broadcast reconciles.
        this.lashes = existing ? this.lashes.map((l) => (l.id === lash.id ? lash : l)) : [lash, ...this.lashes];
        this.notifications.flash(existing ? "Lash updated" : "Lash saved", `"${lash.name}" is in your LashStash.`, "success");
        renderList();
      };
      bar.append(cancel, save);

      // Step list at the TOP (right under the name) so it's the focus and visibly grows as you add;
      // the "Add a step" palette + its inline sub-form sit below it.
      body.append(nameRow, stepsLabel, stepsWrap, insertHint, el("label", "wd-form-label", "Add a step"), chips, subform, bar);
    };

    add.onclick = () => renderEditor(null);
    renderList();
  }

  close(): void {
    if (!this.overlay) return;
    this.teardown();
    this.opts.onDone?.(false);
  }

  // ---- execution -------------------------------------------------------------
  /**
   * Run a lash NOW — as a 3-second scheduled job, so it reuses the host's whole timer pipeline
   * (wake/lock checks, display pinning, persistence, done/failed notifications) and stays
   * cancellable during the countdown. Closes this dialog and tells the opener to drop its own.
   */
  private execute(lash: Lash): void {
    const timerId = uid();
    this.conn.send({
      type: "timer-add",
      id: timerId,
      fireInMs: EXEC_COUNTDOWN_MS,
      label: lash.name,
      action: { kind: "steps", steps: lash.steps, displayId: lash.displayId },
    });
    this.teardown();
    this.opts.onDone?.(true);
    this.showCountdown(lash, timerId);
  }

  /** Floating "Executing “name” in 3…2…1" card with a Cancel that removes the pending timer. */
  private showCountdown(lash: Lash, timerId: string): void {
    const overlay = el("div", "wd-exec-overlay");
    const card = el("div", "wd-exec-card");
    const label = el("div", "wd-exec-label");
    const execIcon = document.createElement("img");
    execIcon.src = lashStashIcon;
    execIcon.alt = "";
    execIcon.decoding = "async";
    execIcon.className = "wd-exec-icon";
    label.appendChild(execIcon);
    const text = el("span", "", "");
    label.appendChild(text);
    const cancel = el("button", "wd-btn");
    cancel.append(el("span", "wd-btn-label", "Cancel"));
    card.append(label, cancel);
    overlay.appendChild(card);
    this.root.appendChild(overlay);

    const fireAt = Date.now() + EXEC_COUNTDOWN_MS;
    const tick = () => {
      const left = Math.ceil((fireAt - Date.now()) / 1000);
      if (left > 0) {
        text.textContent = `Executing “${lash.name}” in ${left}…`;
        return;
      }
      // Fired — the host takes over from here (its notification reports done/failed).
      text.textContent = `Executing “${lash.name}”…`;
      cancel.remove();
      window.clearInterval(timer);
      window.setTimeout(() => overlay.remove(), 1600);
    };
    const timer = window.setInterval(tick, 200);
    tick();
    cancel.onclick = () => {
      this.conn.send({ type: "timer-remove", id: timerId });
      window.clearInterval(timer);
      overlay.remove();
      this.notifications.flash("Cancelled", `"${lash.name}" was not executed.`, "info");
    };
  }

  private pickClose(lash: Lash): void {
    this.teardown();
    this.opts.onPick?.(lash);
  }

  /** Remove the dialog without firing callbacks (the close/pick/execute paths fire their own). */
  private teardown(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.refreshList = null;
  }
}
