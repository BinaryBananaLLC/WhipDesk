import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";

/**
 * Firebase WEB config for the agent's cloud features (device registry + WebRTC signaling).
 * These values are public-safe (the same ones ship in the website's browser bundle) — they
 * are NOT secrets, so they're baked right into this open-source repo (see DEFAULT_CLOUD_CONFIG
 * below). That way cloud works out-of-the-box against the hosted WhipDesk.com service with zero
 * setup. Prefer your own backend? Drop a `.whipdesk/firebase.json` (gitignored) — that's the
 * only override, no env vars.
 *
 * We never use a service-account JSON here; the agent signs in as the REAL user via the
 * free passwordless email-link REST flow (`cloud/auth.ts`).
 */
export interface CloudConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  /** WhipDesk edge (Cloudflare Worker) — presence, signaling, and ICE minting. */
  edgeUrl?: string;
}

/**
 * The DEFAULT backend: the hosted WhipDesk.com Firebase project. These are Firebase WEB config
 * values — public by design (identical to what whipdesk.com serves in its browser bundle), NOT
 * secrets. Shipping them here is what lets `npm run whipdesk` reach the cloud with no config file.
 *
 * Publishing them is safe because access is gated three independent ways:
 *   1. Cloud is OPT-IN — the agent stays LAN-only unless you answer "yes" at startup.
 *      Answer "No" and nothing ever touches Firebase.
 *   2. Every read/write is auth.uid-scoped by the Firestore + RTDB rules: a signed-in user can
 *      only ever touch their OWN subtree, after a real passwordless email-link sign-in.
 *   3. There is NO service-account key here — this is browser-grade config, so it can't grant
 *      admin access or bypass the rules.
 *
 * `storageBucket` is intentionally omitted: the agent only uses Auth + Firestore + RTDB, and
 * Cloud Storage isn't wired up at all (Firestore does NOT depend on it).
 */
export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  apiKey: "AIzaSyCKwUELKrNUY3cfRTKL3rKkoGS_l3VCRJg",
  authDomain: "whipdesk.firebaseapp.com",
  projectId: "whipdesk",
  appId: "1:55602305407:web:4fad59e539c44d6a5d224a",
  messagingSenderId: "55602305407",
  edgeUrl: "https://edge.whipdesk.com",
};

function fromFile(stateDir: string): CloudConfig | null {
  const path = join(stateDir, "firebase.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CloudConfig>;
    if (parsed.apiKey && parsed.projectId && parsed.appId) {
      return {
        ...parsed,
        authDomain: parsed.authDomain ?? `${parsed.projectId}.firebaseapp.com`,
      } as CloudConfig;
    }
    log.warn(`${path} is missing apiKey/projectId/appId — cloud disabled`);
  } catch (error) {
    log.warn(`failed to read ${path}: ${(error as Error).message}`);
  }
  return null;
}

/**
 * The Firebase web config the agent should use. Resolution order (first wins):
 *   1. `.whipdesk/firebase.json` (gitignored) — bring-your-own backend via a local file.
 *   2. The baked-in hosted WhipDesk.com project (DEFAULT_CLOUD_CONFIG).
 * Always returns a usable config; whether the agent actually connects is decided separately by
 * the opt-in prompt (see index.ts).
 */
export function loadCloudConfig(stateDir: string): CloudConfig {
  const cfg = fromFile(stateDir) ?? DEFAULT_CLOUD_CONFIG;
  return { ...cfg, edgeUrl: cfg.edgeUrl ?? DEFAULT_CLOUD_CONFIG.edgeUrl };
}

/**
 * Optional local agent settings — `.whipdesk/settings.json` (gitignored). The ONLY override
 * surface besides firebase.json, per the no-env-vars/no-CLI-params rule. Currently:
 *   { "updateCheck": false }   — disable the daily version check against whipdesk.com/api/version
 */
export interface AgentSettings {
  updateCheck?: boolean;
}

export function loadAgentSettings(stateDir: string): AgentSettings {
  try {
    const path = join(stateDir, "settings.json");
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as AgentSettings;
  } catch {
    return {};
  }
}

/** A stable identity for this machine, persisted under `.whipdesk/` (gitignored). */
export interface DeviceIdentity {
  deviceId: string;
}

function readOrCreate(stateDir: string, file: string, make: () => string): string {
  const path = join(stateDir, file);
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    /* fall through */
  }
  const value = make();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, value, { mode: 0o600 });
  } catch {
    /* non-fatal; value just won't persist */
  }
  return value;
}

export function loadDeviceIdentity(stateDir: string): DeviceIdentity {
  return {
    deviceId: readOrCreate(stateDir, "device-id", () => randomUUID()),
  };
}
