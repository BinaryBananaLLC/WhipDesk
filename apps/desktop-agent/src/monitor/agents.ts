import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
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
  /**
   * Optional precision refinement: peek at the newest transcript's LAST entry to disambiguate the
   * quiet window between "still mid-turn" (a tool is running / the model owns the turn — treat as
   * working) and "turn ended" (waiting on the user). Only consulted when mtime alone is ambiguous.
   */
  tailHint?(cwd: string): Promise<"working" | "waiting" | null>;
}

const home = homedir();
const has = (tokens: string[], name: string) => tokens.includes(name);

// Claude Code stores each project's transcripts under ~/.claude/projects/<cwd with / and . -> ->.
function claudeProjectDir(cwd: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[/\\.]/g, "-"));
}

/**
 * Newest transcript for a session. Prefer the cwd's project dir; when the cwd can't be resolved
 * (common when Claude Code runs embedded in an editor — the VS Code extension — where the process
 * cwd often isn't readable) OR that dir has no transcript, fall back to the most recently ACTIVE
 * project dir. Without this fallback the quiet-window hint below is skipped entirely for editor
 * sessions, so a long "thinking/planning" pause is misread as "waiting on you" and pings falsely.
 */
function newestClaudeJsonl(cwd: string): string | null {
  if (cwd) {
    const own = newestJsonl(claudeProjectDir(cwd));
    if (own) return own;
  }
  const root = join(home, ".claude", "projects");
  let newestDir: string | null = null;
  let newestMs = 0;
  try {
    for (const proj of readdirSync(root)) {
      const dir = join(root, proj);
      try {
        const ms = statSync(dir).mtimeMs;
        if (ms > newestMs) {
          newestMs = ms;
          newestDir = dir;
        }
      } catch {
        /* raced a delete */
      }
    }
  } catch {
    return null;
  }
  return newestDir ? newestJsonl(newestDir) : null;
}

/**
 * The quiet-window disambiguator for Claude Code: read the last complete JSONL line of the newest
 * session transcript and decide whether the model still owns the turn ("working") or has handed it
 * back ("waiting on the user"). The model only TRULY ends its turn with `stop_reason: "end_turn"`
 * (or "stop_sequence"); an unfinished/streaming message, an extended-thinking block, plan text, or
 * a `tool_use` are all still its turn — those must read as WORKING so a thinking/planning agent is
 * never mistaken for one that needs you. A `user` entry (a real prompt or a tool_result fed back)
 * also means the model's turn. Anything unreadable returns null (no hint).
 */
async function claudeTailHint(cwd: string): Promise<"working" | "waiting" | null> {
  const line = readLastJsonlLine(newestClaudeJsonl(cwd));
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string }> | string; stop_reason?: string | null };
    };
    if (entry.type === "user") return "working";
    if (entry.type === "assistant") {
      const content = entry.message?.content;
      // A tool call is still executing / about to run → working.
      if (Array.isArray(content) && content.some((c) => c?.type === "tool_use")) return "working";
      // Only a completed turn hands control back. Thinking/plan/streaming text (no or non-terminal
      // stop_reason) is still the model working — NOT a prompt for the user.
      const stop = entry.message?.stop_reason;
      return stop === "end_turn" || stop === "stop_sequence" ? "waiting" : "working";
    }
  } catch {
    /* torn write mid-line — no hint this poll */
  }
  return null;
}

function newestJsonl(dir: string): string | null {
  let newest: string | null = null;
  let newestMs = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        const ms = statSync(p).mtimeMs;
        if (ms > newestMs) {
          newestMs = ms;
          newest = p;
        }
      } catch {
        /* raced a delete */
      }
    }
  } catch {
    return null;
  }
  return newest;
}

/** Last complete (newline-terminated or trailing) line from the file's final 16KB. */
function readLastJsonlLine(path: string | null): string | null {
  if (!path) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, 16 * 1024);
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    return lines.length ? lines[lines.length - 1]! : null;
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export const AGENTS: AgentDef[] = [
  {
    kind: "claude",
    label: "Claude Code",
    match: (t) => has(t, "claude") || has(t, "claude-code"),
    activityPaths: (cwd) => [...(cwd ? [claudeProjectDir(cwd)] : []), join(home, ".claude", "projects")],
    tailHint: (cwd) => claudeTailHint(cwd),
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
    // ONLY the interactive `copilot` CLI (argv basename), which logs under ~/.copilot. Editor-
    // embedded Copilot (VS Code's extension host, the completions language server, chat-session
    // storage) is deliberately NOT matched: those processes run whenever the editor does and the
    // editor touches that storage during ordinary use, so every heuristic tried produced phantom
    // "busy" sessions while the user wasn't using Copilot at all.
    kind: "copilot",
    label: "Copilot CLI",
    match: (t) => has(t, "copilot"),
    activityPaths: () => [join(home, ".copilot")],
  },
  { kind: "cursor", label: "Cursor Agent", match: (t) => has(t, "cursor-agent"), activityPaths: () => [] },
  {
    // "amp" is too generic for a bare token match anywhere in argv (it collides with unrelated
    // commands/paths); require it to be the LEADING command, or an explicit Sourcegraph marker.
    kind: "amp",
    label: "Amp",
    match: (t, cmd) => t[0] === "amp" || cmd.includes("@sourcegraph/amp"),
    activityPaths: () => [],
  },
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
  copilot: "Copilot CLI",
  opencode: "opencode",
  cursor: "Cursor Agent",
  amp: "Amp",
  unknown: "AI agent",
};

export function agentLabel(kind: AgentKind): string {
  return LABELS[kind];
}
