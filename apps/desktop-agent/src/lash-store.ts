import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LASH_LIMITS, type Lash, type LashStep, type MouseButton } from "@whipdesk/protocol";

// The LashStash: saved multi-step automations ("lashes"). They live in the state dir — NOT in
// the cloud — because their coordinates are tied to this machine's screens: the same pattern as
// timers.json, so they survive agent updates and disappear only with an uninstall. Everything is
// sanitized on the way IN (save + load) so a hand-edited or corrupt file can't make the executor
// click at NaN or type a megabyte.

const FILE = "lashes.json";

const STEP_KINDS = new Set<LashStep["kind"]>(["click", "text", "key", "wait", "display"]);
const BUTTONS = new Set<MouseButton>(["left", "right", "middle"]);

function clamp01(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sanitizeStep(raw: unknown): LashStep | null {
  const s = raw as LashStep;
  if (!s || !STEP_KINDS.has(s.kind)) return null;
  switch (s.kind) {
    case "click":
      if (typeof s.x !== "number" || typeof s.y !== "number") return null;
      return {
        kind: "click",
        x: clamp01(s.x),
        y: clamp01(s.y),
        button: BUTTONS.has(s.button as MouseButton) ? s.button : "left",
        double: s.double === true || undefined,
      };
    case "text":
      if (typeof s.text !== "string" || !s.text) return null;
      return { kind: "text", text: s.text.slice(0, LASH_LIMITS.MAX_TEXT), submit: s.submit !== false };
    case "key":
      if (typeof s.key !== "string" || !s.key) return null;
      return {
        kind: "key",
        key: s.key.slice(0, 24),
        modifiers: Array.isArray(s.modifiers)
          ? s.modifiers.filter((m): m is string => typeof m === "string").slice(0, 4)
          : undefined,
      };
    case "wait": {
      const ms = Math.round(Number(s.ms));
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return { kind: "wait", ms: Math.min(ms, LASH_LIMITS.MAX_WAIT_MS) };
    }
    case "display": {
      const id = Math.round(Number(s.displayId));
      if (!Number.isFinite(id) || id < 0) return null;
      return {
        kind: "display",
        displayId: id,
        displayName: typeof s.displayName === "string" ? s.displayName.slice(0, LASH_LIMITS.MAX_NAME) : undefined,
      };
    }
  }
}

/** Normalize an untrusted lash payload; null when there's nothing executable left. */
export function sanitizeLash(raw: unknown): Lash | null {
  const l = raw as Lash;
  if (!l || typeof l.id !== "string" || !l.id || !Array.isArray(l.steps)) return null;
  const steps = l.steps
    .map(sanitizeStep)
    .filter((s): s is LashStep => s !== null)
    .slice(0, LASH_LIMITS.MAX_STEPS);
  if (steps.length === 0) return null;
  const screen =
    l.screen && typeof l.screen.width === "number" && typeof l.screen.height === "number"
      ? { width: Math.round(l.screen.width), height: Math.round(l.screen.height) }
      : undefined;
  return {
    id: l.id.slice(0, 40),
    name: (typeof l.name === "string" ? l.name : "").trim().slice(0, LASH_LIMITS.MAX_NAME) || "Unnamed lash",
    steps,
    displayId: typeof l.displayId === "number" ? l.displayId : undefined,
    screen,
    createdAt: typeof l.createdAt === "number" ? l.createdAt : Date.now(),
    updatedAt: typeof l.updatedAt === "number" ? l.updatedAt : Date.now(),
  };
}

export function loadLashes(stateDir: string): Lash[] {
  try {
    const raw = readFileSync(join(stateDir, FILE), "utf8");
    const parsed = JSON.parse(raw) as { lashes?: unknown };
    if (!Array.isArray(parsed.lashes)) return [];
    return parsed.lashes
      .map(sanitizeLash)
      .filter((l): l is Lash => l !== null)
      .slice(0, LASH_LIMITS.MAX_LASHES);
  } catch {
    return []; // missing/corrupt file => empty stash
  }
}

export function saveLashes(stateDir: string, lashes: Lash[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, FILE), JSON.stringify({ lashes }), { mode: 0o600 });
  } catch {
    /* non-fatal: lashes just won't survive a restart */
  }
}
