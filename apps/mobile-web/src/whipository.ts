import type { FirebaseWebConfig } from "./remote";
import type { Notifications } from "./notifications";
import { icon } from "./icons";
import whipositoryMark from "./assets/whipository.png";

/**
 * The Whipository — a place where you store and reuse your whips (a whip = a prompt you send
 * often, e.g. "you hit session limit, resume"). Opened from a tiny button next to every prompt
 * text box (Type tab + scheduled-work prompt); picking a whip inserts it into THAT box, never
 * straight into the dev machine.
 *
 * Storage model (deliberately cheap):
 *   - localStorage is ALWAYS the working copy — instant open, works fully offline / on LAN.
 *   - Signed-in cloud sessions sync it to ONE Firestore doc (`users/{uid}/whipository/whips`):
 *     at most ONE read per page session (lazy, on first open) and debounced whole-list writes.
 *     One doc means no per-item read fan-out, and the rules cap list length so nobody can park
 *     megabytes on our bill. Newest `updatedAt` wins between local and cloud (no per-item merge —
 *     predictable beats clever for a personal prompt list).
 */

export interface Whip {
  id: string;
  text: string;
  /** Times inserted — the list is sorted by this, so favourites bubble to the top. */
  uses: number;
  /** Last modified (ms epoch). */
  t: number;
}

interface WhipStoreShape {
  v: 1;
  whips: Whip[];
  /** Set once the starter examples were planted, so deleting them all doesn't respawn them. */
  seeded?: boolean;
  updatedAt: number;
}

/** Caps mirrored in firestore.rules — keep both in sync. */
export const MAX_WHIPS = 50;
export const MAX_WHIP_CHARS = 2000;

const LS_KEY = "wd-whipository";
const CLOUD_WRITE_DEBOUNCE_MS = 2500;
/** Usage-count bumps are cosmetics, not content — batch them much harder. */
const CLOUD_USE_DEBOUNCE_MS = 10_000;

const SEED_WHIPS = [
  "you hit session limit, resume",
  "not fixed, try again, make sure changes you made are needed otherwise remove what you just added",
];

let counter = 0;
function uid(): string {
  return `p${Date.now().toString(36)}${(counter++).toString(36)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class Whipository {
  private store: WhipStoreShape;
  private cloudLoaded = false; // one Firestore read per page session, on first open
  private cloudTimer = 0;
  private overlay: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly notifications: Notifications,
    /** Firebase web config when running as the cloud (whipdesk.com) controller; null on LAN. */
    private readonly cloud: FirebaseWebConfig | null,
  ) {
    this.store = this.loadLocal();
    // LAN has no cloud copy to defer to — plant the starter whips on first run right away.
    if (!this.cloud && !this.store.seeded && this.store.whips.length === 0) this.seed();
  }

  /** Open the dialog; `onInsert` receives the chosen whip's text (goes into the caller's box). */
  open(onInsert: (text: string) => void): void {
    this.close();
    void this.syncFromCloud(); // lazy one-shot; re-renders the list if the cloud copy was newer

    // wd-whips-overlay lifts it above the placement layer (z 40–42), where one entry point lives.
    const overlay = el("div", "wd-dialog-overlay wd-whips-overlay");
    this.overlay = overlay;
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) this.close();
    });
    const card = el("div", "wd-dialog");

    // Header: brand icon + title on the left; a compact "+" add button and the × close on the right.
    // The "+" used to be a full-width "Add whip" bar at the bottom — moving it up here reclaims that
    // whole row for one more whip, and makes clear that adding is a small utility, not the main act.
    const head = el("div", "wd-dialog-head");
    const titleWrap = el("div", "wd-dialog-title");
    const mark = document.createElement("img");
    mark.src = whipositoryMark;
    mark.alt = "";
    mark.decoding = "async";
    mark.className = "wd-dialog-title-icon";
    titleWrap.append(mark, el("h2", "", "Whipository"));
    const headActions = el("div", "wd-dialog-head-actions");
    const add = el("button", "wd-btn wd-icon-only wd-whips-add");
    add.appendChild(icon("plus"));
    add.setAttribute("aria-label", "Add whip");
    add.title = "Add a whip";
    add.onclick = () => openEditor(null);
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = () => this.close();
    headActions.append(add, x);
    head.append(titleWrap, headActions);

    const help = el(
      "p",
      "wd-dialog-help",
      "A place where you store and reuse your whips (AI prompts). Select the one you want to insert into the text box you're typing in.",
    );

    const list = el("div", "wd-whips-list");
    const editorHost = el("div", "wd-whips-editor-host");

    // Honest one-liner about where the list lives — and, on LAN, a nudge to sign in to sync.
    const where = el(
      "p",
      "wd-whips-where",
      this.cloud
        ? "Synchronized across all your devices."
        : "In LAN mode whips are stored locally only. Sign in to share across devices.",
    );

    // Inline delete confirmation: replace the row's buttons with Cancel / Delete so a stray tap can't
    // drop a whip (installed PWAs block window.confirm, so we can't lean on that).
    const confirmDelete = (row: HTMLElement, w: Whip) => {
      const restore = [...row.children];
      row.replaceChildren();
      const ask = el("span", "wd-whip-confirm", "Delete this whip?");
      const cancel = el("button", "wd-btn wd-whip-confirm-btn");
      cancel.append(el("span", "wd-btn-label", "Cancel"));
      cancel.onclick = () => row.replaceChildren(...restore);
      const yes = el("button", "wd-btn wd-danger wd-whip-confirm-btn");
      yes.append(el("span", "wd-btn-label", "Delete"));
      yes.onclick = () => {
        this.store.whips = this.store.whips.filter((x) => x.id !== w.id);
        this.persist();
        renderList();
      };
      row.append(ask, cancel, yes);
    };

    const renderList = () => {
      list.replaceChildren();
      const whips = this.sorted();
      if (whips.length === 0) {
        list.appendChild(el("p", "wd-dialog-help", "No whips yet — tap + to add the prompts you keep retyping."));
        return;
      }
      for (const w of whips) {
        const row = el("div", "wd-whip-row");
        // Tapping the text opens a full-text preview (some whips start alike — let the user read the
        // whole thing before choosing). Only the Insert button actually inserts.
        const pick = el("button", "wd-whip-text");
        pick.type = "button";
        pick.title = "View full text";
        pick.textContent = w.text;
        pick.onclick = () => this.openPreview(w, onInsert);
        const insert = el("button", "wd-btn wd-icon-only");
        insert.appendChild(icon("insert"));
        insert.setAttribute("aria-label", "Insert whip");
        insert.title = "Insert into the text box";
        insert.onclick = () => {
          this.bumpUse(w.id);
          this.close();
          onInsert(w.text);
        };
        const edit = el("button", "wd-btn wd-icon-only");
        edit.appendChild(icon("pencil"));
        edit.setAttribute("aria-label", "Edit whip");
        edit.title = "Edit";
        edit.onclick = () => openEditor(w);
        const del = el("button", "wd-btn wd-icon-only");
        del.appendChild(icon("trash"));
        del.setAttribute("aria-label", "Delete whip");
        del.title = "Delete";
        del.onclick = () => confirmDelete(row, w);
        row.append(pick, insert, edit, del);
        list.appendChild(row);
      }
    };

    const openEditor = (existing: Whip | null) => {
      if (!existing && this.store.whips.length >= MAX_WHIPS) {
        this.notifications.flash("Whipository is full", `Keep it under ${MAX_WHIPS} whips — delete one first.`, "warning");
        return;
      }
      editorHost.replaceChildren();
      add.classList.add("hidden");
      const ta = el("textarea", "wd-input wd-input-area");
      ta.maxLength = MAX_WHIP_CHARS;
      ta.rows = 3;
      ta.placeholder = "The prompt to save…";
      ta.value = existing?.text ?? "";
      const count = el("span", "wd-whips-count");
      const syncCount = () => (count.textContent = `${ta.value.length}/${MAX_WHIP_CHARS}`);
      ta.addEventListener("input", syncCount);
      syncCount();
      const row = el("div", "wd-dialog-actions");
      const cancel = el("button", "wd-btn");
      cancel.append(el("span", "wd-btn-label", "Cancel"));
      cancel.onclick = closeEditor;
      const save = el("button", "wd-btn wd-go");
      save.append(el("span", "wd-btn-label", existing ? "Save" : "Add"));
      save.onclick = () => {
        const text = ta.value.trim();
        if (!text) {
          ta.focus();
          return;
        }
        if (existing) {
          existing.text = text;
          existing.t = Date.now();
        } else {
          this.store.whips.push({ id: uid(), text, uses: 0, t: Date.now() });
        }
        this.persist();
        closeEditor();
        renderList();
      };
      row.append(cancel, save);
      editorHost.append(ta, count, row);
      window.setTimeout(() => ta.focus(), 50);
    };
    const closeEditor = () => {
      editorHost.replaceChildren();
      add.classList.remove("hidden");
    };

    card.append(head, help, list, editorHost, where);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
    renderList();
    // If the cloud copy turns out newer, refresh the open list in place.
    this.onCloudRefresh = renderList;
  }

  /**
   * Full-text preview of a single whip. Opened by tapping a whip's text so the user can read the
   * whole prompt (handy when several start the same) before committing. Its own Insert button is
   * the only path that inserts from here — the list preview never inserts by itself.
   */
  private openPreview(w: Whip, onInsert: (text: string) => void): void {
    const overlay = el("div", "wd-dialog-overlay wd-whips-overlay wd-whip-preview-overlay");
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    const card = el("div", "wd-dialog");
    const head = el("div", "wd-dialog-head");
    head.append(el("h2", "", "Whip"));
    const x = el("button", "wd-dialog-x");
    x.appendChild(icon("x"));
    x.onclick = () => overlay.remove();
    head.appendChild(x);

    const body = el("div", "wd-whip-preview-text");
    body.textContent = w.text; // textContent: prompts are user data, never HTML

    const bar = el("div", "wd-dialog-actions");
    const insert = el("button", "wd-btn wd-go");
    insert.append(icon("insert"), el("span", "wd-btn-label", "Insert"));
    insert.onclick = () => {
      overlay.remove();
      this.bumpUse(w.id);
      this.close();
      onInsert(w.text);
    };
    bar.append(insert);

    card.append(head, body, bar);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
  }

  private onCloudRefresh: (() => void) | null = null;

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.onCloudRefresh = null;
  }

  private sorted(): Whip[] {
    return [...this.store.whips].sort((a, b) => b.uses - a.uses || b.t - a.t);
  }

  private bumpUse(id: string): void {
    const w = this.store.whips.find((x) => x.id === id);
    if (!w) return;
    w.uses += 1;
    this.saveLocal();
    this.scheduleCloudSave(CLOUD_USE_DEBOUNCE_MS); // batched — a use bump is not worth a prompt write each
  }

  private seed(): void {
    const now = Date.now();
    this.store.whips = SEED_WHIPS.map((text) => ({ id: uid(), text, uses: 0, t: now }));
    this.store.seeded = true;
    this.saveLocal();
  }

  /** Content change: save locally now, push to the cloud soon (debounced whole-list write). */
  private persist(): void {
    this.store.updatedAt = Date.now();
    this.saveLocal();
    this.scheduleCloudSave(CLOUD_WRITE_DEBOUNCE_MS);
  }

  // ---- local cache ----------------------------------------------------------
  private loadLocal(): WhipStoreShape {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WhipStoreShape;
        if (parsed && Array.isArray(parsed.whips)) {
          parsed.whips = parsed.whips
            .filter((w) => w && typeof w.text === "string" && typeof w.id === "string")
            .slice(0, MAX_WHIPS);
          return { v: 1, whips: parsed.whips, seeded: !!parsed.seeded, updatedAt: parsed.updatedAt || 0 };
        }
      }
    } catch {
      /* corrupt/unavailable storage -> start fresh */
    }
    return { v: 1, whips: [], updatedAt: 0 };
  }

  private saveLocal(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.store));
    } catch {
      /* storage full/unavailable — the in-memory copy still works this session */
    }
  }

  // ---- cloud sync (remote mode only) ----------------------------------------
  /** One lazy read per page session; the fresher side (by updatedAt) wins outright. */
  private async syncFromCloud(): Promise<void> {
    if (!this.cloud || this.cloudLoaded) return;
    this.cloudLoaded = true;
    try {
      const { doc, getDoc } = await import("firebase/firestore");
      const ctx = await this.cloudCtx();
      if (!ctx) return;
      const snap = await getDoc(doc(ctx.db, "users", ctx.uid, "whipository", "whips"));
      const data = snap.exists() ? (snap.data() as { whips?: Whip[]; updatedAt?: number }) : null;
      if (data && Array.isArray(data.whips)) {
        if ((data.updatedAt || 0) > this.store.updatedAt) {
          this.store = {
            v: 1,
            whips: data.whips.slice(0, MAX_WHIPS),
            seeded: true,
            updatedAt: data.updatedAt || Date.now(),
          };
          this.saveLocal();
          this.onCloudRefresh?.();
        } else if (this.store.updatedAt > (data.updatedAt || 0)) {
          this.scheduleCloudSave(CLOUD_WRITE_DEBOUNCE_MS); // local edits made offline — push them
        }
      } else if (this.store.whips.length === 0 && !this.store.seeded) {
        // Brand-new user everywhere -> plant the starter whips (and sync them up).
        this.seed();
        this.scheduleCloudSave(CLOUD_WRITE_DEBOUNCE_MS);
        this.onCloudRefresh?.();
      } else if (this.store.whips.length > 0) {
        this.scheduleCloudSave(CLOUD_WRITE_DEBOUNCE_MS); // local-only list from before sign-in
      }
    } catch {
      /* offline / rules hiccup — local copy remains the truth for this session */
    }
  }

  private scheduleCloudSave(delayMs: number): void {
    if (!this.cloud) return;
    // An already-armed sooner timer wins; content edits (short delay) override use-bump batching.
    window.clearTimeout(this.cloudTimer);
    this.cloudTimer = window.setTimeout(() => {
      this.cloudTimer = 0;
      void this.pushToCloud();
    }, delayMs);
  }

  private async pushToCloud(): Promise<void> {
    try {
      const { doc, setDoc } = await import("firebase/firestore");
      const ctx = await this.cloudCtx();
      if (!ctx) return;
      await setDoc(doc(ctx.db, "users", ctx.uid, "whipository", "whips"), {
        whips: this.store.whips.slice(0, MAX_WHIPS).map((w) => ({
          id: w.id,
          text: w.text.slice(0, MAX_WHIP_CHARS),
          uses: w.uses,
          t: w.t,
        })),
        updatedAt: this.store.updatedAt || Date.now(),
      });
    } catch {
      /* best-effort — retried on the next change or next session's lazy sync */
    }
  }

  /** Shared Firebase app/auth the remote transport already set up; null when not signed in. */
  private async cloudCtx(): Promise<{ db: import("firebase/firestore").Firestore; uid: string } | null> {
    if (!this.cloud) return null;
    const { initializeApp, getApps } = await import("firebase/app");
    const { getAuth } = await import("firebase/auth");
    const { getFirestore } = await import("firebase/firestore");
    const app = getApps()[0] ?? initializeApp(this.cloud);
    const auth = getAuth(app);
    if (!auth.currentUser) {
      await new Promise<void>((resolve) => {
        const unsub = auth.onAuthStateChanged(() => {
          unsub();
          resolve();
        });
      });
    }
    const user = auth.currentUser;
    if (!user) return null;
    return { db: getFirestore(app), uid: user.uid };
  }
}
