import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { log } from "../logger";

/**
 * Turns the host display ON when a controller connects and keeps it on while one is, then lets it
 * sleep & lock again once everyone's gone.
 *
 * Why this exists: `KeepAwake` deliberately lets the *display* sleep (so the machine locks for
 * security). But once the display has slept, a remote controller only sees black — and on macOS the
 * synthetic mouse/keyboard events we inject (nut.js → CGEvent) do NOT wake the panel, so the user is
 * stuck unable to even reach the password prompt. The reliable fix is an OS power assertion that
 * declares user activity, which is exactly what physically touching the trackpad does. Once the
 * display is on, the normal input path can type the password and unlock as usual.
 *
 * Cross-platform, dependency-free, fail-soft (any spawn error is logged and ignored):
 *   - macOS:   `caffeinate -u -t N` turns the display on (declares user active); `caffeinate -d -w
 *              <pid>` then prevents it re-sleeping while connected (and self-exits if we die).
 *   - Windows: nudge the cursor via `mouse_event` to wake the monitor, then hold ES_DISPLAY_REQUIRED.
 *   - Linux:   `xset dpms force on` (X11, best-effort); re-poked on an interval to hold it on.
 */
export class DisplayWake {
  private hold: ChildProcess | null = null;
  private linuxHold: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly onProcessExit = () => this.stopHold();

  /** Keep the display on while ≥1 controller is connected; release to allow sleep/lock. */
  setActive(active: boolean): void {
    if (active === this.active) {
      if (active) this.wake(); // a fresh controller while already held: still poke the panel on
      return;
    }
    this.active = active;
    if (active) {
      this.wake();
      this.startHold();
    } else {
      this.stopHold();
    }
  }

  /** Turn the display on right now (best-effort, never throws). */
  wake(): void {
    try {
      switch (platform()) {
        case "darwin":
          spawn("caffeinate", ["-u", "-t", "5"], { stdio: "ignore" }).unref();
          break;
        case "win32":
          spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_WAKE], {
            stdio: "ignore",
            windowsHide: true,
          }).unref();
          break;
        case "linux":
          // Reset the screensaver and force DPMS on. Both are no-ops without X (e.g. Wayland).
          spawn("sh", ["-c", "xset s reset; xset dpms force on"], { stdio: "ignore" }).unref();
          break;
      }
    } catch (e) {
      log.debug("wake-display: poke failed —", (e as Error).message);
    }
  }

  private startHold(): void {
    try {
      switch (platform()) {
        case "darwin":
          // Prevent the display re-sleeping while connected; -w ties it to us so it can't outlive us.
          this.hold = spawn("caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore" });
          break;
        case "win32":
          this.hold = spawn(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_HOLD],
            { stdio: "ignore", windowsHide: true },
          );
          break;
        case "linux":
          // No clean inhibitor for DPMS across X/Wayland, so just keep re-poking while connected.
          this.linuxHold = setInterval(() => this.wake(), 50_000);
          this.linuxHold.unref?.();
          return;
      }
    } catch (e) {
      log.debug("wake-display: hold failed —", (e as Error).message);
      return;
    }
    const child = this.hold;
    if (child) {
      child.on("error", (e) => log.debug("wake-display hold unavailable:", (e as Error).message));
      child.unref();
      process.once("exit", this.onProcessExit);
      log.debug("wake-display: holding display on while a controller is connected");
    }
  }

  private stopHold(): void {
    process.removeListener("exit", this.onProcessExit);
    if (this.linuxHold) {
      clearInterval(this.linuxHold);
      this.linuxHold = null;
    }
    const child = this.hold;
    this.hold = null;
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

// Nudge the cursor (0,0 relative move = no real movement) to wake the monitor, then briefly assert
// ES_DISPLAY_REQUIRED so it turns back on if it was idle-off, and exit.
const WINDOWS_WAKE = [
  "$sig = '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e); [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';",
  "$p = Add-Type -MemberDefinition $sig -Name WhipDeskWake -Namespace WhipDesk -PassThru;",
  "$p::mouse_event(0x0001, 0, 0, 0, [System.IntPtr]::Zero);",
  "[void]$p::SetThreadExecutionState(([uint32]'0x80000000') -bor ([uint32]'0x00000002'));",
  "Start-Sleep -Milliseconds 200;",
].join(" ");

// Holds ES_CONTINUOUS | ES_DISPLAY_REQUIRED for the life of this process (killed on release),
// keeping the monitor on while a controller is connected.
const WINDOWS_HOLD = [
  "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';",
  "$p = Add-Type -MemberDefinition $sig -Name WhipDeskHold -Namespace WhipDesk -PassThru;",
  "[void]$p::SetThreadExecutionState(([uint32]'0x80000000') -bor ([uint32]'0x00000002'));",
  "while ($true) { Start-Sleep -Seconds 3600 }",
].join(" ");
