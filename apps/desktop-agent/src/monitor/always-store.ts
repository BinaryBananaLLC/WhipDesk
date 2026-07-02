import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "@whipdesk/protocol";

// "Always alert" mode is per agent kind and must outlive both the agent and WhipDesk itself, so it's
// persisted here (not in memory like manual monitors). One tiny JSON file in the state dir:
//   { "agents": ["claude", "codex"] }
// Reloaded at startup so background monitoring resumes for those kinds with no user action.

const FILE = "monitor-always.json";

const KNOWN: ReadonlySet<AgentKind> = new Set<AgentKind>([
  "claude",
  "codex",
  "gemini",
  "aider",
  "copilot",
  "opencode",
  "cursor",
  "amp",
  "unknown",
]);

export function loadAlwaysAgents(stateDir: string): AgentKind[] {
  try {
    const raw = readFileSync(join(stateDir, FILE), "utf8");
    const parsed = JSON.parse(raw) as { agents?: unknown };
    if (!Array.isArray(parsed.agents)) return [];
    // Drop anything unrecognized so a stale/renamed kind can never wedge the monitor.
    return [...new Set(parsed.agents.filter((a): a is AgentKind => KNOWN.has(a as AgentKind)))];
  } catch {
    return []; // missing/corrupt file => nothing is always-on
  }
}

export function saveAlwaysAgents(stateDir: string, agents: AgentKind[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const unique = [...new Set(agents.filter((a) => KNOWN.has(a)))];
    writeFileSync(join(stateDir, FILE), JSON.stringify({ agents: unique }), { mode: 0o600 });
  } catch {
    /* non-fatal: the toggle just won't persist across restarts */
  }
}
