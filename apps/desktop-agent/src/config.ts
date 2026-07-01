import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "@whipdesk/protocol";

export const AGENT_VERSION = "0.1.0";

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop-agent/src -> repo root
const repoRoot = join(here, "..", "..", "..");
const stateDir = join(repoRoot, ".whipdesk");

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
