import type { MonitorState } from "@whipdesk/protocol";

/** One observation of a session, fused by `inferState`. */
export interface Sample {
  /** Was the agent process found this poll? */
  present: boolean;
  /** %CPU of the agent process itself (0 when unknown). */
  cpu: number;
  /**
   * Busiest %CPU among the agent's descendant processes (the bash/build/test subprocesses it
   * spawns). A quiet transcript with a busy child means "running a tool", not "waiting on you".
   */
  subtreeCpu: number;
  /** now - newest transcript mtime, or null when no transcript is available. */
  activityAgeMs: number | null;
}

export interface Thresholds {
  /** %CPU at/above which the agent (or one of its children) counts as working. */
  cpuWorking: number;
  /** Transcript written more recently than this => working. */
  workingFreshMs: number;
  /** Activity within this window (but not fresh) => the turn may have ended, so it's waiting on you. */
  blockedWindowMs: number;
  /**
   * "blocked" must persist this long before it's surfaced. A working agent often goes quiet between
   * transcript writes (streaming a long reply, running a tool); we only call it "needs you" after the
   * quiet is sustained. Any transcript write or CPU spike inside the window resets it to working.
   */
  blockedConfirmMs: number;
  /** "idle" must persist this long before it's surfaced (debounces working<->idle flap). */
  idleConfirmMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpuWorking: 6,
  workingFreshMs: 8_000,
  blockedWindowMs: 120_000,
  blockedConfirmMs: 24_000,
  idleConfirmMs: 6_000,
};

/**
 * Infer an agent's *instantaneous* state from a single sample and its previous state. Activity-driven
 * (mirrors the "terminal/transcript as status API" approach): fresh writes, high CPU, or a busy child
 * process mean working; a recent burst that just stopped means it may be blocked waiting on you; a
 * long quiet means idle. Disappearing while working reads as a crash, otherwise a clean finish.
 *
 * This is only the per-poll reading. The caller debounces "blocked"/"idle" over time
 * (`blockedConfirmMs`/`idleConfirmMs`) so a single quiet poll mid-turn is never mistaken for an agent
 * that needs you — see `SessionMonitor.transition`.
 */
export function inferState(prev: MonitorState, s: Sample, th: Thresholds = DEFAULT_THRESHOLDS): MonitorState {
  if (!s.present) return prev === "working" ? "crashed" : "finished";
  // The agent or any tool it spawned is actively burning CPU => working, even with a stale transcript
  // (e.g. a long build/test/install writes nothing to the transcript while it runs).
  if (s.cpu >= th.cpuWorking || s.subtreeCpu >= th.cpuWorking) return "working";
  if (s.activityAgeMs != null) {
    if (s.activityAgeMs < th.workingFreshMs) return "working";
    if (s.activityAgeMs < th.blockedWindowMs) return "blocked";
    return "idle";
  }
  // No transcript signal and nothing busy: nothing to act on => idle.
  return "idle";
}
