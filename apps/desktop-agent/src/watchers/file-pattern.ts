import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs";
import { log } from "../logger";
import type { NotificationHub } from "../notifications";

/**
 * Tails a file and emits a notification for each appended line matching `pattern`.
 * One concrete source for the "AI is done" use case; the generic path is the
 * `POST /api/notify` webhook.
 */
export function startFileWatcher(path: string, pattern: string, hub: NotificationHub): void {
  if (!existsSync(path)) {
    log.warn(`file watcher: ${path} does not exist (skipping)`);
    return;
  }

  const regex = new RegExp(pattern, "i");
  let offset = safeSize(path);
  log.info(`file watcher: tailing ${path} for /${pattern}/i`);

  const onChange = () => {
    try {
      const size = safeSize(path);
      if (size < offset) offset = 0; // rotated / truncated
      if (size === offset) return;

      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;

      for (const line of buffer.toString("utf8").split(/\r?\n/)) {
        if (line && regex.test(line)) {
          hub.emit({
            title: "Watcher matched",
            body: line.slice(0, 200),
            level: "success",
            source: `file-watcher:${path}`,
          });
        }
      }
    } catch (error) {
      log.warn("file watcher read error", (error as Error).message);
    }
  };

  try {
    watch(path, { persistent: false }, onChange);
  } catch (error) {
    log.warn("file watcher failed to start", (error as Error).message);
  }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
