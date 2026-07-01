import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { log } from "../logger";

/**
 * Keeps the host machine awake while the agent runs, so a controller can always reach it.
 *
 * We block SYSTEM / idle sleep ONLY — the DISPLAY is intentionally allowed to sleep and the
 * session to lock, so the machine stays secure and the user can type their password to
 * unlock. Cross-platform, dependency-free (we drive each OS's built-in mechanism):
 *
 *   - macOS:   `caffeinate -i -w <pid>` — prevent idle system sleep, tied to our PID so it
 *              also self-exits if the agent dies. No `-d`, so the display can still sleep.
 *   - Windows: a resident PowerShell holding `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (no
 *              `ES_DISPLAY_REQUIRED`), released when the process is killed.
 *   - Linux:   `systemd-inhibit --what=sleep:idle ... sleep infinity` (best-effort; needs
 *              systemd — otherwise we log and carry on).
 *
 * Fail-soft: any spawn/launch error is logged and ignored; the agent keeps running.
 */
export class KeepAwake {
  private child: ChildProcess | null = null;
  private started = false;
  private readonly onProcessExit = () => this.kill();

  start(): void {
    if (this.started) return;
    this.started = true;

    let child: ChildProcess | null;
    try {
      child = this.spawnBlocker();
    } catch (error) {
      log.warn("keep-awake: could not start —", (error as Error).message);
      return;
    }
    if (!child) {
      log.warn(`keep-awake: unsupported platform ${platform()} — the system may sleep`);
      return;
    }

    this.child = child;
    // ENOENT etc. (e.g. systemd-inhibit missing) surface here, not as a throw.
    child.on("error", (e) => log.warn("keep-awake unavailable:", (e as Error).message));
    child.unref(); // don't keep our event loop alive on the blocker's account
    process.once("exit", this.onProcessExit); // best-effort cleanup if we crash out
    log.info("keep-awake: blocking system sleep while running (display may still sleep)");
  }

  stop(): void {
    this.started = false;
    process.removeListener("exit", this.onProcessExit);
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private spawnBlocker(): ChildProcess | null {
    switch (platform()) {
      case "darwin":
        return spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      case "win32":
        return spawn(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_KEEP_AWAKE],
          { stdio: "ignore", windowsHide: true },
        );
      case "linux":
        return spawn(
          "systemd-inhibit",
          [
            "--what=sleep:idle",
            "--who=WhipDesk",
            "--why=Remote access agent is running",
            "--mode=block",
            "sleep",
            "infinity",
          ],
          { stdio: "ignore" },
        );
      default:
        return null;
    }
  }
}

// Holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED for the life of this PowerShell process (killed
// by stop()), telling Windows the system must stay awake. ES_DISPLAY_REQUIRED is omitted on
// purpose so the monitor can still turn off and the session can lock.
const WINDOWS_KEEP_AWAKE = [
  "$sig = '[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);';",
  "$p = Add-Type -MemberDefinition $sig -Name WhipDeskPower -Namespace WhipDesk -PassThru;",
  "[void]$p::SetThreadExecutionState(([uint32]'0x80000000') -bor ([uint32]'0x00000001'));",
  "while ($true) { Start-Sleep -Seconds 3600 }",
].join(" ");
