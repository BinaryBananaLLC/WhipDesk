import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LASH_LIMITS, type Lash, type LashStep, type MouseButton } from "@whipdesk/protocol";

// The LashStash: saved multi-step automations ("lashes"). They live in the state dir — NOT in
// the cloud — because their coordinates are tied to this machine's screens: the same pattern as
// timers.json, so they survive agent updates and disappear only with an uninstall. Everything is
// sanitized on the way IN (save + load) so a hand-edited or corrupt file can't make the executor
// click at NaN or type a megabyte.
//
// AT REST the file is ENCRYPTED (AES-256-GCM): a lash can hold the literal keystrokes to unlock
// this box — including a password — so it must not sit in cleartext where a backup, a cloud-synced
// folder, or a shoulder over the terminal could read it. See loadOrCreateKey() for the (honest)
// threat model and why we can't one-way hash a password we later have to TYPE.

const FILE = "lashes.json";
const KEY_FILE = "lash.key"; // 32-byte AES key for the stash — this machine only, 0600
const ENC_TAG = "wdlash1"; // marker on the at-rest envelope so we can tell it from legacy plaintext

interface Envelope {
  enc: string;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * Load (or first-time mint) this machine's 32-byte lash key, kept beside the data (0600). Because
 * a lash may need to TYPE a password to unlock the box, the agent must be able to recover the
 * plaintext unattended — so the key can't depend on a human secret at run time and therefore lives
 * on the same disk. That makes this real defense-in-depth (backups, synced folders, an accidentally
 * shared file, a glance at the JSON) but NOT protection against an attacker who already has full
 * access to this user account — which is exactly why a one-way hash is impossible here.
 */
function loadOrCreateKey(stateDir: string): Buffer {
  const path = join(stateDir, KEY_FILE);
  try {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length === 32) return key;
  } catch {
    /* missing/corrupt -> mint a fresh one below */
  }
  const key = randomBytes(32);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  return key;
}

/** Wrap a JSON document in an authenticated AES-256-GCM envelope for on-disk storage. */
function seal(stateDir: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadOrCreateKey(stateDir), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const env: Envelope = {
    enc: ENC_TAG,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(env);
}

/** Reverse of seal(); throws on a wrong key or tampered ciphertext (GCM auth). */
function unseal(stateDir: string, env: Envelope): string {
  const decipher = createDecipheriv("aes-256-gcm", loadOrCreateKey(stateDir), Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
}

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
    const outer = JSON.parse(raw) as Partial<Envelope> & { lashes?: unknown };
    // Current format is the encrypted envelope; a legacy pre-encryption file has `lashes` directly
    // and is read as-is (the next save re-writes it sealed). Anything else -> empty stash.
    const parsed =
      outer && outer.enc === ENC_TAG
        ? (JSON.parse(unseal(stateDir, outer as Envelope)) as { lashes?: unknown })
        : outer;
    if (!Array.isArray(parsed.lashes)) return [];
    return parsed.lashes
      .map(sanitizeLash)
      .filter((l): l is Lash => l !== null)
      .slice(0, LASH_LIMITS.MAX_LASHES);
  } catch {
    return []; // missing/corrupt/undecryptable file => empty stash
  }
}

export function saveLashes(stateDir: string, lashes: Lash[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, FILE), seal(stateDir, JSON.stringify({ lashes })), { mode: 0o600 });
  } catch {
    /* non-fatal: lashes just won't survive a restart */
  }
}
