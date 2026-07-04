import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { homedir, platform } from "node:os";
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
   * The process's own %CPU is meaningless for this agent, so state inference must not use it.
   * Needed for editor-embedded agents (VS Code's extension host runs EVERY extension plus things
   * like tsserver children — its CPU says nothing about whether Copilot is generating).
   */
  ignoreCpu?: boolean;
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
 * The quiet-window disambiguator for Claude Code: read the last complete JSONL line of the newest
 * session transcript. An assistant entry that ends in `tool_use` means a tool is still executing
 * (working); an assistant entry that ends in text means the turn is over (waiting on the user); a
 * user entry means the model owns the turn (working). Anything unreadable returns null (no hint).
 */
async function claudeTailHint(cwd: string): Promise<"working" | "waiting" | null> {
  const line = readLastJsonlLine(newestJsonl(claudeProjectDir(cwd)));
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string }> | string };
    };
    if (entry.type === "user") return "working";
    if (entry.type === "assistant") {
      const content = entry.message?.content;
      if (Array.isArray(content) && content.some((c) => c?.type === "tool_use")) return "working";
      return "waiting";
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

// ---------------------------------------------------------------------------
// VS Code Copilot Chat: it runs INSIDE the extension-host process (no `copilot` in any argv), so
// process matching alone can't see it. Two extra signals make it observable:
//  1. Match the extension host itself when a Copilot extension is installed (checked below).
//  2. Watch VS Code's chat-session storage as the activity path — Copilot Chat appends to
//     workspaceStorage/<hash>/chatSessions/*.json as a conversation progresses, which is exactly
//     the transcript-mtime signal the state machine already runs on.
// ---------------------------------------------------------------------------

/** VS Code user-data roots per platform (stable + Insiders + OSS builds). */
function vsCodeUserDirs(): string[] {
  const variants = ["Code", "Code - Insiders", "VSCodium"];
  if (platform() === "darwin") return variants.map((v) => join(home, "Library", "Application Support", v, "User"));
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return variants.map((v) => join(appData, v, "User"));
  }
  return variants.map((v) => join(home, ".config", v, "User"));
}

/** The most recently used workspaces' chat-session dirs (bounded so polling stays cheap). */
function vsCodeChatSessionDirs(): string[] {
  const out: Array<{ path: string; ms: number }> = [];
  for (const user of vsCodeUserDirs()) {
    const storage = join(user, "workspaceStorage");
    let entries: string[];
    try {
      entries = readdirSync(storage);
    } catch {
      continue;
    }
    for (const hash of entries) {
      for (const kind of ["chatSessions", "chatEditingSessions"]) {
        const dir = join(storage, hash, kind);
        try {
          out.push({ path: dir, ms: statSync(dir).mtimeMs });
        } catch {
          /* workspace has no chat storage */
        }
      }
    }
  }
  return out
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((e) => e.path);
}

/** Is a GitHub Copilot extension available in any VS Code variant? Cached — checked at most once a
 * minute, because `match` runs for every process on every 3s poll. */
let copilotInstalledCache: { value: boolean; at: number } | null = null;
function vsCodeCopilotInstalled(): boolean {
  const now = Date.now();
  if (copilotInstalledCache && now - copilotInstalledCache.at < 60_000) return copilotInstalledCache.value;
  let value = false;
  for (const dir of [join(home, ".vscode", "extensions"), join(home, ".vscode-insiders", "extensions"), join(home, ".vscode-oss", "extensions")]) {
    try {
      if (readdirSync(dir).some((e) => e.toLowerCase().startsWith("github.copilot"))) {
        value = true;
        break;
      }
    } catch {
      /* variant not installed */
    }
  }
  // Copilot Chat ships BUILT-IN in recent VS Code (not under .vscode/extensions), so also treat the
  // presence of chat-session storage as "Copilot available" — that storage is only written by chat.
  if (!value) value = vsCodeChatSessionDirs().length > 0;
  copilotInstalledCache = { value, at: now };
  return value;
}

/** The VS Code extension-host process (hosts Copilot Chat). The marker moved across versions:
 * legacy `--type=extensionHost`; some builds `extensionHostProcess`; modern VS Code (1.80+) runs it
 * as a Node UTILITY process with NO "extensionHost" string at all — it's the `node.mojom.NodeService`
 * that carries an `--inspect-port` (extension debugging), which the sibling shared-process / file-
 * watcher / pty-host node services do not. */
function isVsCodeExtensionHost(cmd: string): boolean {
  return (
    cmd.includes("--type=extensionhost") ||
    cmd.includes("extensionhostprocess") ||
    (cmd.includes("node.mojom.nodeservice") && cmd.includes("--inspect-port"))
  );
}

export const AGENTS: AgentDef[] = [
  {
    kind: "claude",
    label: "Claude Code",
    match: (t) => has(t, "claude") || has(t, "claude-code"),
    activityPaths: (cwd) => [...(cwd ? [claudeProjectDir(cwd)] : []), join(home, ".claude", "projects")],
    tailHint: (cwd) => (cwd ? claudeTailHint(cwd) : Promise.resolve(null)),
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
    // Four ways Copilot shows up, in matching order:
    //  - the `copilot` CLI (argv basename), which logs under ~/.copilot;
    //  - the completions language server, a child process whose command line carries
    //    `copilot-language-server` or the extension path `github.copilot[-chat]`;
    //  - Copilot CHAT, which runs inside VS Code's extension host with NO copilot marker in any
    //    argv — matched via the extension host itself when a Copilot extension is installed, with
    //    VS Code's chat-session storage as the transcript (see vsCodeChatSessionDirs).
    // CPU is ignored: the extension host runs every extension (plus tsserver children), so its CPU
    // says nothing about Copilot — chat-storage mtime is the real signal.
    kind: "copilot",
    label: "GitHub Copilot",
    match: (t, cmd) =>
      has(t, "copilot") ||
      cmd.includes("copilot-language-server") ||
      cmd.includes("github.copilot") ||
      (isVsCodeExtensionHost(cmd) && vsCodeCopilotInstalled()),
    activityPaths: () => [join(home, ".copilot"), ...vsCodeChatSessionDirs()],
    ignoreCpu: true,
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
  copilot: "GitHub Copilot",
  opencode: "opencode",
  cursor: "Cursor Agent",
  amp: "Amp",
  unknown: "AI agent",
};

export function agentLabel(kind: AgentKind): string {
  return LABELS[kind];
}
