import { execFile } from "node:child_process";
import { log } from "./logger";

/**
 * Desktop-side "is this thing on?" reminder. WhipDesk runs headless, so we surface presence
 * two cheap, dependency-free ways:
 *   1. the terminal title (always shows running state + live watcher count), and
 *   2. a macOS notification when someone starts/stops watching.
 */
export class Presence {
  private watchers = 0;

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
    const dot = this.watchers > 0 ? "🔴" : "🟢";
    const label =
      this.watchers > 0 ? `WhipDesk · 👀 ${this.watchers} watching` : "WhipDesk · running";
    this.setTitle(`${dot} ${label}`);
  }

  /** Called whenever the authenticated watcher count changes. */
  update(watchers: number): void {
    const previous = this.watchers;
    this.watchers = watchers;
    this.render();

    if (previous === 0 && watchers > 0) {
      log.info(`👀 someone is whipping your screen (${watchers} watching)`);
      this.notify("👀 Someone is whipping your screen", "A WhipDesk controller just connected.");
    } else if (previous > 0 && watchers === 0) {
      log.info("screen no longer being watched");
      this.notify("WhipDesk", "All controllers disconnected — nobody is watching now.");
    } else if (watchers !== previous && watchers > 0) {
      this.render();
    }
  }

  /** Reset the title on shutdown. */
  stop(): void {
    this.setTitle("WhipDesk");
  }
}
