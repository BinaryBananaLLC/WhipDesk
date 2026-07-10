import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "@whipdesk/protocol";
import { isPackaged } from "./util/paths";

// Single source of truth, generated from package.json (scripts/sync-version.mjs). Re-exported here
// because callers (index.ts, cloud registry) already import it from "./config".
export { AGENT_VERSION } from "./version";

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop-agent/src -> repo root
const repoRoot = join(here, "..", "..", "..");
// A source checkout keeps state in the repo (.whipdesk, gitignored). A distributed build (SEA
// download or `npm i -g`) has no source tree, so state lives in the user's home — this also means
// pairing token / PIN / cloud identity SURVIVE an update, which is what lets us skip backward-compat.
const stateDir = isPackaged() ? join(homedir(), ".whipdesk") : join(repoRoot, ".whipdesk");

export interface AgentConfig {
  port: number;
  token: string;
  fps: number;
  quality: number;
  maxWidth: number;
  watchFile?: string;
  watchRegex: string;
  stateDir: string;
  /** Block system/idle sleep while the agent runs (display may still sleep). Default on. */
  keepAwake: boolean;
}

function loadOrCreateToken(): string {
  // The pairing token lives only in `.whipdesk/token` (gitignored): read it if present, otherwise
  // generate + persist one so the saved QR/link keeps working between restarts.
  const tokenPath = join(stateDir, "token");
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    /* fall through to generate */
  }

  const token = randomBytes(16).toString("hex");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    /* non-fatal: token simply won't persist */
  }
  return token;
}

// User-chosen display name for this machine (set from the controller's connection dialog).
// Persisted next to the token so it survives updates; empty/missing means "use the OS hostname".
const MACHINE_NAME_MAX = 64;

export function loadMachineName(dir: string): string {
  try {
    return readFileSync(join(dir, "machine-name"), "utf8").trim().slice(0, MACHINE_NAME_MAX);
  } catch {
    return "";
  }
}

export function saveMachineName(dir: string, name: string): void {
  const clean = name.trim().slice(0, MACHINE_NAME_MAX);
  try {
    if (!clean) {
      rmSync(join(dir, "machine-name"), { force: true }); // back to the OS hostname
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "machine-name"), clean, "utf8");
  } catch {
    /* non-fatal: the rename simply won't survive a restart */
  }
}

export function loadConfig(): AgentConfig {
  return {
    port: DEFAULTS.PORT,
    token: loadOrCreateToken(),
    fps: DEFAULTS.FPS,
    quality: DEFAULTS.JPEG_QUALITY,
    maxWidth: DEFAULTS.MAX_WIDTH,
    watchFile: undefined,
    watchRegex: "done|finished|completed",
    stateDir,
    keepAwake: true,
  };
}
