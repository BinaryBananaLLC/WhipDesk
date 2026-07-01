import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "@whipdesk/protocol";

/** A supported AI coding agent: how to spot its process + where it leaves activity traces. */
export interface AgentDef {
  kind: AgentKind;
  label: string;
  /**
   * True when this agent is identified by either its argv basenames (`tokens`) or a marker in the
   * full, lowercased command line (`command`). The full line is needed for editor-embedded agents
   * (e.g. VS Code Copilot) whose telltale string is a path SEGMENT, not an argv basename.
   */
  match(tokens: string[], command: string): boolean;
  /**
   * Files/dirs whose newest mtime signals the agent is doing something. These transcripts/logs are
   * written by the agents themselves with no setup, which is what makes monitoring zero-config.
   * `cwd` (the agent's working dir) may be "" when it couldn't be resolved.
   */
  activityPaths(cwd: string): string[];
}

const home = homedir();
const has = (tokens: string[], name: string) => tokens.includes(name);

// Claude Code stores each project's transcripts under ~/.claude/projects/<cwd with / and . -> ->.
function claudeProjectDir(cwd: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[/\\.]/g, "-"));
}

export const AGENTS: AgentDef[] = [
  {
    kind: "claude",
    label: "Claude Code",
    match: (t) => has(t, "claude") || has(t, "claude-code"),
    activityPaths: (cwd) => [...(cwd ? [claudeProjectDir(cwd)] : []), join(home, ".claude", "projects")],
  },
  {
    kind: "codex",
    label: "Codex CLI",
    match: (t) => has(t, "codex"),
    activityPaths: () => [join(home, ".codex", "sessions"), join(home, ".codex", "log")],
  },
  {
    kind: "gemini",
    label: "Gemini CLI",
    match: (t) => has(t, "gemini"),
    activityPaths: () => [join(home, ".gemini", "tmp")],
  },
  {
    kind: "aider",
    label: "Aider",
    match: (t) => has(t, "aider"),
    activityPaths: (cwd) => (cwd ? [join(cwd, ".aider.chat.history.md")] : []),
  },
  {
    kind: "opencode",
    label: "opencode",
    match: (t) => has(t, "opencode"),
    activityPaths: () => [join(home, ".local", "share", "opencode")],
  },
  {
    // The CLI is `copilot` (argv basename); inside VS Code, Copilot runs a separate language-server
    // process whose command line carries the extension path (`github.copilot[-chat]`) and/or the
    // dedicated `copilot-language-server` binary — neither survives basename tokenization, so we
    // sniff the full command line for those markers too. (Found alongside Claude Code etc.)
    kind: "copilot",
    label: "GitHub Copilot",
    match: (t, cmd) =>
      has(t, "copilot") || cmd.includes("copilot-language-server") || cmd.includes("github.copilot"),
    activityPaths: () => [],
  },
  { kind: "cursor", label: "Cursor Agent", match: (t) => has(t, "cursor-agent"), activityPaths: () => [] },
  { kind: "amp", label: "Amp", match: (t) => has(t, "amp"), activityPaths: () => [] },
];

// Leading commands that merely mention an agent's name (so we don't flag `grep claude`, `ps`, etc.).
const NOISE_LEADERS = new Set(["grep", "rg", "ag", "ack", "ps", "pgrep", "tail", "head", "less", "more", "man", "watch", "awk", "sed"]);

export function matchAgent(tokens: string[], command: string): AgentDef | null {
  if (tokens.length && NOISE_LEADERS.has(tokens[0]!)) return null;
  const cmd = command.toLowerCase();
  for (const def of AGENTS) if (def.match(tokens, cmd)) return def;
  return null;
}

const LABELS: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  aider: "Aider",
  copilot: "GitHub Copilot",
  opencode: "opencode",
  cursor: "Cursor Agent",
  amp: "Amp",
  unknown: "AI agent",
};

export function agentLabel(kind: AgentKind): string {
  return LABELS[kind];
}
