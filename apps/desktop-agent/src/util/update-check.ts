import { log } from "../logger";
import { loadAgentSettings, loadCloudConfig } from "../cloud/config";

/**
 * Best-effort update check against whipdesk.com/api/version (a Cloudflare Worker fronting the
 * GitHub releases API — same `{ tag_name }` shape, but never rate-limited per user).
 *
 * PRIVACY (documented in README "Privacy & telemetry"): the request carries the agent version
 * (User-Agent `whipdesk/x.y.z`) and the OS platform header — nothing else. No user id, no
 * machine id; the server counts version/platform/country aggregates only and never stores IPs.
 * Disable entirely with `{ "updateCheck": false }` in `.whipdesk/settings.json`.
 *
 * Runs at startup and every 24 h (agents run for weeks — a startup-only check would never tell
 * a long-running agent about a new release). Never throws, never blocks startup.
 */

const DEFAULT_VERSION_URL = "https://whipdesk.com/api/version";
const RECHECK_MS = 24 * 3600_000;

export async function checkForUpdate(current: string, versionUrl = DEFAULT_VERSION_URL): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(versionUrl, {
      headers: {
        accept: "application/json",
        "user-agent": `whipdesk/${current}`,
        "x-whipdesk-platform": process.platform,
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    const latest = (body.tag_name ?? "").replace(/^v/, "");
    return latest && isNewer(latest, current) ? latest : null;
  } catch {
    return null; // offline / firewalled / endpoint down — all fine
  }
}

export interface UpdateChecksHandle {
  stop: () => void;
}

/**
 * Startup + daily update checks. Respects the `.whipdesk/settings.json` opt-out and announces
 * each newer version at most once per process.
 */
export function startUpdateChecks(
  current: string,
  stateDir: string,
  notify: (n: { title: string; body: string; level: "info"; source: string }) => void,
): UpdateChecksHandle {
  if (loadAgentSettings(stateDir).updateCheck === false) {
    log.info("update check: disabled via .whipdesk/settings.json");
    return { stop() {} };
  }
  const versionUrl = loadCloudConfig(stateDir).versionUrl ?? DEFAULT_VERSION_URL;
  const announced = new Set<string>();
  const run = () =>
    void checkForUpdate(current, versionUrl).then((latest) => {
      if (latest && !announced.has(latest)) {
        announced.add(latest);
        announceUpdate(latest, current, notify);
      }
    });
  run();
  const timer = setInterval(run, RECHECK_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Plain numeric MAJOR.MINOR.PATCH comparison; anything unparsable is "not newer". */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i]! !== c[i]!) return l[i]! > c[i]!;
  }
  return false;
}

/** Log + surface the notice through the given notifier. */
export function announceUpdate(latest: string, current: string, notify: (n: { title: string; body: string; level: "info"; source: string }) => void): void {
  log.info(`update available: v${latest} (running v${current}) — https://github.com/BinaryBananaLLC/WhipDesk/releases/latest`);
  notify({
    title: "WhipDesk update available",
    body: `v${latest} is out (you're on v${current}). Update with your installer — npm/brew/scoop — or the releases page. One-liners per method: whipdesk.com or docs/UPDATING.md.`,
    level: "info",
    source: "update",
  });
}
