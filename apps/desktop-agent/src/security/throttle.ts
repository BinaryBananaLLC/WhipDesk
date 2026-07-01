import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Brute-force protection for the connection PIN that SURVIVES reconnects and process restarts.
 *
 * The per-connection counter in `transport/session.ts` only limits attempts within a single
 * socket — an attacker could reset it by reconnecting. This throttle is the real gate: it
 * tracks failures per client identity (LAN IP, or the controller uid on the WebRTC path) AND a
 * global failure budget, with an escalating lockout, persisted to `.whipdesk/pin-attempts.json`
 * (mode 0600) so a restart can't wipe it.
 *
 * Design goals: stop online brute force without enabling a trivial self-DoS. A single client
 * that keeps failing is locked out with exponential backoff; the global cap is generous and
 * short so a flood can't permanently lock out the legitimate owner.
 */

const MAX_FAILS_PER_CLIENT = 5; // failures before a client is locked out
const BASE_LOCKOUT_MS = 60_000; // first lockout window; doubles each subsequent lockout
const MAX_LOCKOUT_MS = 60 * 60_000; // cap the escalation at 1 hour
const ATTEMPT_DECAY_MS = 30 * 60_000; // forget a client's failures after this idle period
const GLOBAL_WINDOW_MS = 5 * 60_000; // rolling window for the global failure budget
const GLOBAL_MAX_FAILS = 50; // failures across all clients in the window -> brief global cooldown
const GLOBAL_COOLDOWN_MS = 60_000;

interface ClientState {
  fails: number;
  lockouts: number;
  lockedUntil: number;
  lastFailMs: number;
}

interface Persisted {
  clients: Record<string, ClientState>;
  global: { windowStart: number; fails: number; lockedUntil: number };
}

export interface ThrottleDecision {
  locked: boolean;
  retryAfterMs: number;
}

export class PinThrottle {
  private readonly path: string;
  private state: Persisted;

  constructor(stateDir: string) {
    this.path = join(stateDir, "pin-attempts.json");
    this.state = this.load();
  }

  private load(): Persisted {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Persisted>;
        return {
          clients: parsed.clients ?? {},
          global: parsed.global ?? { windowStart: 0, fails: 0, lockedUntil: 0 },
        };
      }
    } catch {
      /* corrupt/unset -> start clean */
    }
    return { clients: {}, global: { windowStart: 0, fails: 0, lockedUntil: 0 } };
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.state), { mode: 0o600 });
    } catch {
      /* non-fatal: throttle still works in-memory for this run */
    }
  }

  private key(clientId: string | undefined): string {
    return clientId && clientId.trim() ? clientId.trim() : "unknown";
  }

  /** Is this client (or the whole agent) currently locked out? Call before verifying a PIN. */
  check(clientId: string | undefined): ThrottleDecision {
    const now = Date.now();
    if (this.state.global.lockedUntil > now) {
      return { locked: true, retryAfterMs: this.state.global.lockedUntil - now };
    }
    const c = this.state.clients[this.key(clientId)];
    if (c && c.lockedUntil > now) {
      return { locked: true, retryAfterMs: c.lockedUntil - now };
    }
    return { locked: false, retryAfterMs: 0 };
  }

  /** Record a failed PIN attempt; returns the (possibly new) lockout decision for this client. */
  recordFailure(clientId: string | undefined): ThrottleDecision {
    const now = Date.now();
    const key = this.key(clientId);
    const c = this.state.clients[key] ?? { fails: 0, lockouts: 0, lockedUntil: 0, lastFailMs: 0 };

    // Decay stale failures so an honest user who mistyped once long ago starts fresh.
    if (now - c.lastFailMs > ATTEMPT_DECAY_MS) {
      c.fails = 0;
      c.lockouts = 0;
    }
    c.fails += 1;
    c.lastFailMs = now;

    let decision: ThrottleDecision = { locked: false, retryAfterMs: 0 };
    if (c.fails >= MAX_FAILS_PER_CLIENT) {
      const window = Math.min(BASE_LOCKOUT_MS * 2 ** c.lockouts, MAX_LOCKOUT_MS);
      c.lockedUntil = now + window;
      c.lockouts += 1;
      c.fails = 0; // reset the run; the escalating window does the punishing
      decision = { locked: true, retryAfterMs: window };
    }
    this.state.clients[key] = c;

    // Global budget: independent of any single client, so distributed guessing also trips it.
    const g = this.state.global;
    if (now - g.windowStart > GLOBAL_WINDOW_MS) {
      g.windowStart = now;
      g.fails = 0;
    }
    g.fails += 1;
    if (g.fails >= GLOBAL_MAX_FAILS) {
      g.lockedUntil = now + GLOBAL_COOLDOWN_MS;
      g.fails = 0;
      if (!decision.locked) decision = { locked: true, retryAfterMs: GLOBAL_COOLDOWN_MS };
    }

    this.persist();
    return decision;
  }

  /** Clear a client's failure history after a successful auth. */
  recordSuccess(clientId: string | undefined): void {
    const key = this.key(clientId);
    if (this.state.clients[key]) {
      delete this.state.clients[key];
      this.persist();
    }
  }
}
