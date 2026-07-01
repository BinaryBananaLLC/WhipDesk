import { basename } from "node:path";
import type {
  AgentKind,
  MonitorEvent,
  MonitorInfo,
  MonitorSessionInfo,
  MonitorState,
} from "@whipdesk/protocol";
import { log } from "../logger";
import { agentLabel, matchAgent } from "./agents";
import { listProcesses, processCwd, type ProcInfo } from "./processes";
import { DEFAULT_THRESHOLDS, inferState } from "./state";
import { newestActivity } from "./transcript";

interface Session {
  key: string;
  agent: AgentKind;
  title: string;
  pid: number;
  cwd: string;
  activityPaths: string[];
  state: MonitorState;
  /** A candidate next state awaiting time-based confirmation (see `transition`). */
  candidate: MonitorState | null;
  /** When `candidate` was first observed (epoch ms), so we can require it to persist. */
  candidateSince: number;
}

interface Watch {
  id: string;
  key: string;
  agent: AgentKind;
  label: string;
  events: Set<MonitorEvent>;
  state: MonitorState;
  live: boolean;
}

export interface MonitorCallbacks {
  notify(input: { title: string; body: string; level: "info" | "success" | "warning" | "error"; source: string }): void;
  /** The monitors list/state changed — push it to controllers. */
  onMonitors(monitors: MonitorInfo[]): void;
}

const POLL_MS = 3000;
const EVENT_STATES = new Set<MonitorState>(["blocked", "idle", "finished", "crashed"]);

/**
 * Zero-config AI-agent session monitor. It periodically lists processes, matches known agents,
 * resolves each one's state from CPU + transcript activity, and fires the events a user subscribed
 * to. No wrappers, hooks, or changes to how agents are launched — it only observes. The poll loop
 * runs solely while at least one monitor is active.
 */
export class SessionMonitor {
  private readonly sessions = new Map<string, Session>();
  private readonly watches = new Map<string, Watch>();
  private readonly cwdCache = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastSignature = "";

  constructor(private readonly cb: MonitorCallbacks) {}

  /** Refresh now and return the discovered sessions (used to populate the "Add monitor" picker). */
  async scan(): Promise<MonitorSessionInfo[]> {
    await this.poll();
    return this.listSessions();
  }

  listSessions(): MonitorSessionInfo[] {
    const watchedKeys = new Set([...this.watches.values()].map((w) => w.key));
    return [...this.sessions.values()].map((s) => ({
      key: s.key,
      agent: s.agent,
      title: s.title,
      pid: s.pid,
      state: s.state,
      watched: watchedKeys.has(s.key),
    }));
  }

  listMonitors(): MonitorInfo[] {
    return [...this.watches.values()].map((w) => ({
      id: w.id,
      key: w.key,
      agent: w.agent,
      label: w.label,
      events: [...w.events],
      state: w.state,
      live: w.live,
    }));
  }

  addWatch(m: { id: string; key: string; agent: AgentKind; label: string; events: MonitorEvent[] }): void {
    const session = this.sessions.get(m.key);
    const events = m.events.length ? m.events : (["blocked", "finished", "crashed"] as MonitorEvent[]);
    this.watches.set(m.id, {
      id: m.id,
      key: m.key,
      agent: m.agent,
      label: m.label,
      events: new Set(events),
      state: session?.state ?? "unknown",
      live: !!session,
    });
    this.ensureTicker();
    this.emitMonitors(true);
  }

  removeWatch(id: string): void {
    if (!this.watches.delete(id)) return;
    this.emitMonitors(true);
    if (this.watches.size === 0) this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTicker(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  private async cwdFor(pid: number): Promise<string> {
    const cached = this.cwdCache.get(pid);
    if (cached !== undefined) return cached;
    const cwd = await processCwd(pid).catch(() => "");
    this.cwdCache.set(pid, cwd);
    return cwd;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const procs = await listProcesses();
      const livePids = new Set(procs.map((p) => p.pid));
      for (const pid of [...this.cwdCache.keys()]) if (!livePids.has(pid)) this.cwdCache.delete(pid);

      // Map each process to its children so we can tell "running a tool" (a busy child) from
      // "waiting on you" (the whole subtree is idle).
      const children = new Map<number, ProcInfo[]>();
      for (const p of procs) {
        const arr = children.get(p.ppid);
        if (arr) arr.push(p);
        else children.set(p.ppid, [p]);
      }

      const seen = new Set<string>();
      for (const p of procs) {
        if (p.pid === process.pid) continue;
        const def = matchAgent(p.tokens, p.command);
        if (!def) continue;
        const cwd = await this.cwdFor(p.pid);
        const key = `${def.kind}:${cwd || p.tty || p.pid}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let s = this.sessions.get(key);
        if (!s) {
          s = {
            key,
            agent: def.kind,
            title: cwd ? basename(cwd) || def.label : def.label,
            pid: p.pid,
            cwd,
            activityPaths: def.activityPaths(cwd),
            state: "unknown",
            candidate: null,
            candidateSince: 0,
          };
          this.sessions.set(key, s);
        } else {
          s.pid = p.pid;
        }
        for (const w of this.watches.values()) if (w.key === key) w.live = true;

        const activity = await newestActivity(s.activityPaths);
        this.transition(s, inferState(s.state === "unknown" ? "idle" : s.state, {
          present: true,
          cpu: p.cpu,
          subtreeCpu: subtreeCpu(p.pid, children),
          activityAgeMs: activity == null ? null : Math.max(0, Date.now() - activity),
        }));
      }

      // Anything not seen this poll has exited.
      for (const s of [...this.sessions.values()]) {
        if (seen.has(s.key)) continue;
        this.transition(s, inferState(s.state, { present: false, cpu: 0, subtreeCpu: 0, activityAgeMs: null }));
        this.sessions.delete(s.key);
        for (const w of this.watches.values()) if (w.key === s.key) w.live = false;
      }

      this.emitMonitors(false);
    } catch (e) {
      log.debug("monitor poll error:", (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private transition(s: Session, next: MonitorState): void {
    if (next === s.state) {
      s.candidate = null;
      return;
    }
    // "blocked"/"idle" only commit after they persist for a confirm window — a working agent often
    // pauses between transcript writes, and one quiet poll must not read as "needs you". "working"
    // and the terminal states (crashed/finished) surface immediately so the UI stays responsive.
    // If the agent resumes during the window, inferState returns to the live state and clears the
    // candidate above, so the timer effectively resets.
    const confirmMs =
      next === "blocked" ? DEFAULT_THRESHOLDS.blockedConfirmMs : next === "idle" ? DEFAULT_THRESHOLDS.idleConfirmMs : 0;
    if (confirmMs > 0) {
      const now = Date.now();
      if (s.candidate !== next) {
        s.candidate = next;
        s.candidateSince = now;
        return;
      }
      if (now - s.candidateSince < confirmMs) return;
    }
    s.candidate = null;
    const prev = s.state;
    s.state = next;
    for (const w of this.watches.values()) {
      if (w.key !== s.key) continue;
      w.state = next;
      if (EVENT_STATES.has(next) && w.events.has(next as MonitorEvent)) {
        this.cb.notify({
          title: `${agentLabel(w.agent)} — ${stateText(next)}`,
          body: w.label && w.label !== s.title ? `${w.label} (${s.title})` : s.title,
          level: levelFor(next),
          source: `monitor:${w.agent}`,
        });
      }
    }
    log.debug(`monitor: ${s.agent} ${s.title} ${prev} -> ${next}`);
  }

  /** Broadcast the monitors list, deduped (poll calls this every tick; only changes go out). */
  private emitMonitors(force: boolean): void {
    const list = this.listMonitors();
    const sig = JSON.stringify(list);
    if (!force && sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.cb.onMonitors(list);
  }
}

/** Busiest %CPU among all descendants of `rootPid` (0 if it has none). Bounded against cycles. */
function subtreeCpu(rootPid: number, children: Map<number, ProcInfo[]>): number {
  let max = 0;
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (p.cpu > max) max = p.cpu;
    const kids = children.get(p.pid);
    if (kids) stack.push(...kids);
  }
  return max;
}

function stateText(state: MonitorState): string {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      return "needs you";
    case "idle":
      return "idle";
    case "finished":
      return "finished";
    case "crashed":
      return "exited unexpectedly";
    default:
      return state;
  }
}

function levelFor(state: MonitorState): "info" | "success" | "warning" | "error" {
  if (state === "crashed") return "error";
  if (state === "blocked") return "warning";
  if (state === "finished") return "success";
  return "info";
}
