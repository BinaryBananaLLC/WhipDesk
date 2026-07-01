import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PIN-based connection auth. The agent never stores the PIN in plaintext: it persists a
 * stretched key `K = stretch(pin, salt, iterations)`. On connect it issues a one-time
 * `nonce`; the controller (which knows the PIN) computes the same `K` and returns
 * `response = sha256(K + ":" + nonce)`. The agent compares against `sha256(K + ":" + nonce)`
 * using a constant-time check. The PIN and `K` never cross the wire, and the nonce blocks
 * replay.
 *
 * The KDF is a sha256 iteration chain (not PBKDF2) ON PURPOSE: the browser controller runs
 * over plain http on the LAN, where `crypto.subtle` is unavailable (non-secure origin), so
 * both ends share a tiny pure-JS sha256 instead. Identical construction => identical bytes.
 *
 * Threat model (MVP): stops someone who reaches the device IP/URL but doesn't know the PIN.
 * A LAN traffic sniffer could offline-brute-force a short PIN from a captured handshake;
 * the WebRTC (DTLS) path removes that exposure, and the agent rate-limits attempts.
 */

const ITERATIONS = 60_000;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Stretch a PIN into a hex key. Mirrors the browser implementation byte-for-byte. */
export function stretch(pin: string, salt: string, iterations: number): string {
  let h = sha256Hex(`${salt}:${pin}`);
  for (let i = 1; i < iterations; i++) h = sha256Hex(h);
  return h;
}

export function responseFor(key: string, nonce: string): string {
  return sha256Hex(`${key}:${nonce}`);
}

export interface PinRecord {
  salt: string;
  iterations: number;
  key: string;
}

export class PinGuard {
  private record: PinRecord | null;
  private readonly path: string;

  private constructor(stateDir: string, record: PinRecord | null) {
    this.path = join(stateDir, "pin.json");
    this.record = record;
  }

  static load(stateDir: string): PinGuard {
    const path = join(stateDir, "pin.json");
    let record: PinRecord | null = null;
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PinRecord>;
        if (parsed.salt && parsed.key && typeof parsed.iterations === "number") {
          record = { salt: parsed.salt, key: parsed.key, iterations: parsed.iterations };
        }
      }
    } catch {
      /* treat as unset */
    }
    return new PinGuard(stateDir, record);
  }

  get isSet(): boolean {
    return this.record !== null;
  }

  get iterations(): number {
    return this.record?.iterations ?? ITERATIONS;
  }

  get salt(): string {
    return this.record?.salt ?? "";
  }

  /** Persist a new PIN (>= 4 chars). Stores only the stretched key. */
  setPin(pin: string): void {
    if (pin.length < 4) throw new Error("PIN must be at least 4 characters");
    const salt = randomBytes(16).toString("hex");
    const key = stretch(pin, salt, ITERATIONS);
    this.record = { salt, iterations: ITERATIONS, key };
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
    } catch {
      /* dir exists */
    }
    writeFileSync(this.path, JSON.stringify(this.record), { mode: 0o600 });
  }

  /** Remove any persisted PIN (run without a connection PIN). */
  clear(): void {
    this.record = null;
    try {
      rmSync(this.path, { force: true });
    } catch {
      /* nothing to remove */
    }
  }

  /** Fresh per-connection nonce (hex). */
  issueNonce(): string {
    return randomBytes(16).toString("hex");
  }

  /** Constant-time check of a controller's challenge response. */
  verify(nonce: string, response: string): boolean {
    if (!this.record) return true; // no PIN configured => open
    const expected = responseFor(this.record.key, nonce);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(response), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
