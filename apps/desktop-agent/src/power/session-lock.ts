import { execFile } from "node:child_process";
import { platform } from "node:os";

/**
 * Best-effort "is the console session locked?" probe.
 *
 * Why: a scheduled action (auto-click + prompt) fired into a LOCKED session doesn't reach the
 * target app — on macOS the CGEvents land on loginwindow, on Windows the secure desktop swallows
 * them. Worse, typed text could end up in the password box. So before running a scheduled action
 * we check the lock state and fail loudly (push notification) instead of silently "succeeding".
 *
 * Returns true (locked), false (unlocked), or null (unknown — caller should proceed, since most
 * sessions are unlocked and a false positive would block legitimate scheduled work).
 *
 *   - macOS:   `ioreg -n Root -d1` exposes `IOConsoleLocked = Yes/No` (flips the moment the
 *              lock screen is up, including "require password after sleep").
 *   - Windows: `LogonUI.exe` only runs while the secure desktop (lock/logon screen) is shown.
 *   - Linux:   too DE-specific to probe reliably — report unknown.
 */
export async function isSessionLocked(): Promise<boolean | null> {
  try {
    switch (platform()) {
      case "darwin": {
        const out = await run("ioreg", ["-n", "Root", "-d1"]);
        const m = /"IOConsoleLocked"\s*=\s*(Yes|No)/.exec(out);
        return m ? m[1] === "Yes" : null;
      }
      case "win32": {
        const out = await run("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"]);
        return /LogonUI\.exe/i.test(out);
      }
      default:
        return null;
    }
  } catch {
    return null; // probe failure must never block the action itself
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}
