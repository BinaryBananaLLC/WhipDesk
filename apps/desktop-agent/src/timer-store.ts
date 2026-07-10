import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduledAction } from "@whipdesk/protocol";

// One-shot timers must survive an agent restart: a "click retry + send the prompt in 3h"
// scheduled from the phone is exactly the thing the user is NOT around to re-create when the
// agent gets restarted in the meantime. Tiny JSON file in the state dir (same pattern as
// monitor-always.json). Timers that came due while the agent was down are surfaced as a
// "missed" notification at startup — never blindly executed hours late into whatever is on
// screen by then.

const FILE = "timers.json";

export interface StoredTimer {
  id: string;
  label: string;
  fireAtMs: number;
  action?: ScheduledAction;
  /** Display the action was aimed at when scheduled — click coords are display-relative, so the
   * action must run on THIS display even if the active display changed since. */
  displayId?: number;
}

export function loadTimers(stateDir: string): StoredTimer[] {
  try {
    const raw = readFileSync(join(stateDir, FILE), "utf8");
    const parsed = JSON.parse(raw) as { timers?: unknown };
    if (!Array.isArray(parsed.timers)) return [];
    return parsed.timers.filter(
      (t): t is StoredTimer =>
        !!t && typeof (t as StoredTimer).id === "string" && typeof (t as StoredTimer).fireAtMs === "number",
    );
  } catch {
    return []; // missing/corrupt file => no timers to restore
  }
}

export function saveTimers(stateDir: string, timers: StoredTimer[]): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, FILE), JSON.stringify({ timers }), { mode: 0o600 });
  } catch {
    /* non-fatal: timers just won't survive a restart */
  }
}
