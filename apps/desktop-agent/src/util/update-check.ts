import { log } from "../logger";

/**
 * Best-effort update check against GitHub releases (public API, no auth, no telemetry — the
 * request carries nothing but a UA). Called once at startup for PACKAGED agents only; source
 * checkouts update via git. Never throws, never blocks startup, returns the newer version or null.
 */
export async function checkForUpdate(current: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("https://api.github.com/repos/BinaryBananaLLC/WhipDesk/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": `whipdesk/${current}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string };
    const latest = (body.tag_name ?? "").replace(/^v/, "");
    return latest && isNewer(latest, current) ? latest : null;
  } catch {
    return null; // offline / rate-limited / firewalled — all fine
  }
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
    body: `v${latest} is out (this agent is v${current}). Update via your install method — brew, npm, or the release page.`,
    level: "info",
    source: "update",
  });
}
