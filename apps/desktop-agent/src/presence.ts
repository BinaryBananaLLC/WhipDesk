import { execFile } from "node:child_process";
import { log } from "./logger";

/**
 * Desktop-side "is this thing on?" reminder. WhipDesk runs headless, so we surface presence
 * two cheap, dependency-free ways:
 *   1. the terminal title (always shows running state + whether someone is watching), and
 *   2. a macOS notification when someone starts/stops watching.
 */
export class Presence {
  private watching = false;

  start(): void {
    this.render();
  }

  private notify(title: string, body: string): void {
    if (process.platform !== "darwin") return;
    const escape = (s: string) => s.replace(/[\\"]/g, "\\$&");
    const script = `display notification "${escape(body)}" with title "${escape(title)}"`;
    execFile("osascript", ["-e", script], () => undefined);
  }

  private setTitle(text: string): void {
    // OSC 2 ; <text> BEL — sets the terminal window/tab title.
    if (process.stdout.isTTY) process.stdout.write(`\u001b]2;${text}\u0007`);
  }

  private render(): void {
    const dot = this.watching ? "🔴" : "🟢";
    const label = this.watching ? "WhipDesk · 👀 watching" : "WhipDesk · running";
    this.setTitle(`${dot} ${label}`);
  }

  /** Called whenever an authenticated watcher connects or disconnects. */
  update(watching: boolean): void {
    const previous = this.watching;
    this.watching = watching;
    this.render();

    if (!previous && watching) {
      log.info("👀 someone is whipping your screen");
      this.notify("👀 Someone is whipping your screen", "A WhipDesk controller just connected.");
    } else if (previous && !watching) {
      log.info("screen no longer being watched");
      this.notify("WhipDesk", "Controller disconnected — nobody is watching now.");
    }
  }

  /** Reset the title on shutdown. */
  stop(): void {
    this.setTitle("WhipDesk");
  }
}
