import { basename } from "node:path";
import type { AgentKind, MonitorInfo, MonitorSessionInfo, MonitorState } from "@whipdesk/protocol";
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
  /** See AgentDef.ignoreCpu — editor-embedded agents whose host CPU is meaningless. */
  ignoreCpu: boolean;
  /** See AgentDef.tailHint — transcript-tail disambiguation for the quiet window. */
  tailHint: ((cwd: string) => Promise<"working" | "waiting" | null>) | null;
  state: MonitorState;
  /** A candidate next state awaiting time-based confirmation (see `transition`). */
  candidate: MonitorState | null;
  /** When `candidate` was first observed (epoch ms), so we can require it to persist. */
  candidateSince: number;
  /** Last "the agent is working" signal from an external hook (epoch ms; 0 = none). */
  externalActivityAt: number;
  /** When an external hook declared the turn over (epoch ms; 0 = none). Cleared when the
   * transcript is written again AFTER this instant — the agent demonstrably resumed. */
  externalStoppedAt: number;
}

interface Watch {
  id: string;
  key: string;
  agent: AgentKind;
  label: string;
  state: MonitorState;
  live: boolean;
  /** True for watches created implicitly by "always alert" mode (one per always-on agent kind's
   * live session). Auto-watches are driven by `alwaysAgents`, not shown in the monitors list, and
   * torn down with the session — the user manages them via the per-kind toggle, not individually. */
  auto: boolean;
}

export interface MonitorCallbacks {
  notify(input: { title: string; body: string; level: "info" | "success" | "warning" | "error"; source: string }): void;
  /** The monitors list/state changed — push it to controllers. */
  onMonitors(monitors: MonitorInfo[]): void;
}

const POLL_MS = 3000;
// Everything that isn't "working" (and isn't the initial "unknown") counts as "not working".
const NOT_WORKING = new Set<MonitorState>(["blocked", "idle", "finished", "crashed"]);

/**
 * Zero-config AI-agent session monitor. It periodically lists processes, matches known agents,
 * resolves each one's state from CPU + transcript activity, and fires a SINGLE kind of alert — the
 * agent stopped working (it's waiting on you or has gone idle/exited). No wrappers, hooks, or changes
 * to how agents are launched — it only observes. The poll loop runs while any monitor is active OR
 * while any agent kind has "always alert" mode on.
 */
export class SessionMonitor {
  private readonly sessions = new Map<string, Session>();
  private readonly watches = new Map<string, Watch>();
  private readonly cwdCache = new Map<number, string>();
  /** Agent kinds in "always alert" mode: every live session of these is auto-watched. */
  private always = new Set<AgentKind>();
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

  /** Only user-created monitors are listed; auto-watches are surfaced via the always-on toggles. */
  listMonitors(): MonitorInfo[] {
    return [...this.watches.values()]
      .filter((w) => !w.auto)
      .map((w) => ({
        id: w.id,
        key: w.key,
        agent: w.agent,
        label: w.label,
        state: w.state,
        live: w.live,
      }));
  }

  addWatch(m: { id: string; key: string; agent: AgentKind; label: string }): void {
    const session = this.sessions.get(m.key);
    this.watches.set(m.id, {
      id: m.id,
      key: m.key,
      agent: m.agent,
      label: m.label,
      state: session?.state ?? "unknown",
      live: !!session,
      auto: false,
    });
    this.ensureTicker();
    this.emitMonitors(true);
  }

  removeWatch(id: string): void {
    if (!this.watches.delete(id)) return;
    this.emitMonitors(true);
    this.maybeStop();
  }

  /**
   * Set which agent kinds are in "always alert" mode. Auto-watches for kinds no longer in the set are
   * dropped immediately; kinds newly added get auto-watches for their live sessions on the next poll
   * (a poll is kicked off now so it takes effect at once). Starts/stops the poll loop as needed.
   */
  setAlwaysAgents(agents: AgentKind[]): void {
    this.always = new Set(agents);
    for (const [id, w] of this.watches) {
      if (w.auto && !this.always.has(w.agent)) this.watches.delete(id);
    }
    if (this.always.size > 0) {
      this.ensureTicker();
      void this.poll();
    } else {
      this.maybeStop();
    }
  }

  /**
   * Precision mode: an agent-native hook (e.g. Claude Code's Stop/Notification hooks POSTing to
   * /api/agent-event) tells us EXACTLY when a turn ends or input is needed — no inference delay,
   * no debounce. Entirely optional; process+transcript observation keeps working without it.
   * Returns false when no live session of that kind matched (the caller reports 404).
   */
  recordAgentEvent(agent: AgentKind, event: "working" | "stopped", cwd?: string): boolean {
    const sessions = [...this.sessions.values()].filter((s) => s.agent === agent);
    const session = (cwd && sessions.find((s) => s.cwd === cwd)) || (sessions.length === 1 ? sessions[0] : null);
    if (!session) return false;
    if (event === "working") {
      session.externalActivityAt = Date.now();
      session.externalStoppedAt = 0;
      this.transition(session, "working");
    } else {
      session.externalActivityAt = 0;
      session.externalStoppedAt = Date.now();
      // The hook is authoritative — surface "waiting on you" NOW, skipping the confirm window.
      this.transition(session, "blocked", true);
    }
    this.emitMonitors(false);
    return true;
  }

  /** The poll loop only needs to run while there's something to observe. */
  private maybeStop(): void {
    if (this.watches.size === 0 && this.always.size === 0) this.stop();
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
            ignoreCpu: def.ignoreCpu ?? false,
            tailHint: def.tailHint ?? null,
            state: "unknown",
            candidate: null,
            candidateSince: 0,
            externalActivityAt: 0,
            externalStoppedAt: 0,
          };
          this.sessions.set(key, s);
        } else {
          s.pid = p.pid;
        }
        for (const w of this.watches.values()) if (w.key === key) w.live = true;

        // "Always alert" mode: give every live session of an always-on kind a hidden auto-watch, so
        // it's monitored with no per-session setup (and keeps working after a restart).
        if (this.always.has(def.kind) && ![...this.watches.values()].some((w) => w.key === key)) {
          this.watches.set(`auto:${key}`, {
            id: `auto:${key}`,
            key,
            agent: def.kind,
            label: s.title,
            state: s.state,
            live: true,
            auto: true,
          });
        }

        const activity = await newestActivity(s.activityPaths);
        const now = Date.now();
        let activityAgeMs = activity == null ? null : Math.max(0, now - activity);
        // External hook signals refine the picture (see recordAgentEvent):
        //  - a "working" event counts as fresh activity;
        //  - a "stopped" event means the last transcript burst was the turn ENDING, so its fresh
        //    mtime must not read as "working" — until the transcript is written again afterwards.
        if (s.externalActivityAt) {
          const extAge = now - s.externalActivityAt;
          if (activityAgeMs == null || extAge < activityAgeMs) activityAgeMs = Math.max(0, extAge);
        }
        if (s.externalStoppedAt) {
          if (activity != null && activity > s.externalStoppedAt) s.externalStoppedAt = 0;
          else if (activityAgeMs != null) activityAgeMs = Math.max(activityAgeMs, DEFAULT_THRESHOLDS.workingFreshMs);
        }
        // Quiet window (not fresh, not yet idle) is ambiguous: mid-turn pause vs turn over. Agents
        // with a readable transcript tail can disambiguate — "working" keeps it working.
        if (
          s.tailHint &&
          activityAgeMs != null &&
          activityAgeMs >= DEFAULT_THRESHOLDS.workingFreshMs &&
          activityAgeMs < DEFAULT_THRESHOLDS.blockedWindowMs
        ) {
          const hint = await s.tailHint(s.cwd).catch(() => null);
          if (hint === "working") activityAgeMs = 0;
        }
        this.transition(s, inferState(s.state === "unknown" ? "idle" : s.state, {
          present: true,
          cpu: s.ignoreCpu ? 0 : p.cpu,
          subtreeCpu: s.ignoreCpu ? 0 : subtreeCpu(p.pid, children),
          activityAgeMs,
        }));
      }

      // Anything not seen this poll has exited.
      for (const s of [...this.sessions.values()]) {
        if (seen.has(s.key)) continue;
        this.transition(s, inferState(s.state, { present: false, cpu: 0, subtreeCpu: 0, activityAgeMs: null }));
        this.sessions.delete(s.key);
        // Auto-watches are recreated when a session of the kind reappears, so drop the dead one;
        // manual watches stay (marked not-live) so the user still sees them until they remove them.
        for (const [id, w] of this.watches) {
          if (w.key !== s.key) continue;
          if (w.auto) this.watches.delete(id);
          else w.live = false;
        }
      }

      this.emitMonitors(false);
    } catch (e) {
      log.debug("monitor poll error:", (e as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private transition(s: Session, next: MonitorState, immediate = false): void {
    if (next === s.state) {
      s.candidate = null;
      return;
    }
    // "blocked"/"idle" only commit after they persist for a confirm window — a working agent often
    // pauses between transcript writes, and one quiet poll must not read as "needs you". "working"
    // and the terminal states (crashed/finished) surface immediately so the UI stays responsive.
    // If the agent resumes during the window, inferState returns to the live state and clears the
    // candidate above, so the timer effectively resets. `immediate` (hook-driven events) skips the
    // confirm window: the agent itself told us, so there is nothing to debounce.
    const confirmMs = immediate
      ? 0
      : next === "blocked" ? DEFAULT_THRESHOLDS.blockedConfirmMs : next === "idle" ? DEFAULT_THRESHOLDS.idleConfirmMs : 0;
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
    // The one and only alert: a working agent just stopped (blocked on you, idle, or exited). Going
    // between not-working states (e.g. blocked -> idle, or idle -> exited) never re-alerts, so each
    // "the agent stopped" episode pings exactly once.
    const stoppedWorking = prev === "working" && NOT_WORKING.has(next);
    for (const w of this.watches.values()) {
      if (w.key !== s.key) continue;
      w.state = next;
      if (stoppedWorking) {
        const where = w.label && w.label !== s.title ? `${w.label} (${s.title})` : s.title;
        this.cb.notify({
          title: `${agentLabel(w.agent)} isn't working`,
          body: notWorkingBody(next, where),
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

/** Body for the "isn't working" alert, phrased for why it stopped. `where` is the session label. */
function notWorkingBody(state: MonitorState, where: string): string {
  switch (state) {
    case "blocked":
      return `${where} — it's waiting on you.`;
    case "idle":
      return `${where} — it's gone idle.`;
    case "crashed":
      return `${where} — it stopped unexpectedly.`;
    case "finished":
      return `${where} — it finished.`;
    default:
      return where;
  }
}

function levelFor(state: MonitorState): "info" | "success" | "warning" | "error" {
  if (state === "crashed") return "error";
  if (state === "blocked") return "warning";
  if (state === "finished") return "success";
  return "info";
}
