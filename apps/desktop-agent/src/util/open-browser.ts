import { execFile } from "node:child_process";

/** Open a URL in the user's default browser (best-effort, cross-platform). */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, args, () => undefined);
  } catch {
    /* non-fatal: the URL is also printed to the console */
  }
}
