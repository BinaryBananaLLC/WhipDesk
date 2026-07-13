import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Host clipboard read/write via the OS's own tools, NOT nut.js's `clipboard`. nut.js delegates to
 * clipboardy, which resolves bundled fallback binaries (windows .exe / linux xsel) relative to its
 * package __dirname — paths that don't exist once the module is esbuild-inlined into agent.cjs
 * (see scripts/build-bundle.mjs). Shelling out keeps the SEA/npm bundles working everywhere:
 *   - macOS:   pbcopy / pbpaste (always present)
 *   - Windows: powershell Get-Clipboard / Set-Clipboard, with text carried via a temp file so
 *              UTF-8 survives the console codepage
 *   - Linux:   wl-clipboard on Wayland, else xclip, else xsel (whichever is installed)
 */

// Read buffer ceiling — clipboard text is capped to CLIPBOARD_MAX_TEXT afterwards anyway,
// but the OS tool may hand us more before we truncate.
const MAX_BUFFER = 8 * 1024 * 1024;

/** UTF-8 locale for pbcopy/pbpaste: a non-UTF-8 LC_CTYPE silently mangles non-ASCII text. */
const MAC_ENV = { ...process.env, LC_CTYPE: "UTF-8" };

function findOnPath(bin: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, bin)));
}

interface LinuxTool {
  read: [string, string[]];
  write: [string, string[]];
}

let linuxToolCache: LinuxTool | null | undefined;

/** Pick the first available Linux clipboard tool. Wayland sessions prefer wl-clipboard. */
function linuxTool(): LinuxTool | null {
  if (linuxToolCache !== undefined) return linuxToolCache;
  const candidates: Array<{ bin: string; tool: LinuxTool }> = [
    { bin: "wl-copy", tool: { read: ["wl-paste", ["--no-newline"]], write: ["wl-copy", []] } },
    {
      bin: "xclip",
      tool: { read: ["xclip", ["-selection", "clipboard", "-out"]], write: ["xclip", ["-selection", "clipboard", "-in"]] },
    },
    { bin: "xsel", tool: { read: ["xsel", ["--clipboard", "--output"]], write: ["xsel", ["--clipboard", "--input"]] } },
  ];
  if (!process.env.WAYLAND_DISPLAY) candidates.push(candidates.shift()!); // X11: try xclip/xsel first
  linuxToolCache = candidates.find((c) => findOnPath(c.bin))?.tool ?? null;
  return linuxToolCache;
}

/** Whether this host can serve clipboard-copy/clipboard-write (advertised in `welcome`). */
export function clipboardAvailable(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return linuxTool() !== null;
}

/** Single-quote a value for embedding in a PowerShell command ('' escapes '). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShell(script: string): Promise<void> {
  await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: MAX_BUFFER },
  );
}

/** Run a PowerShell snippet that exchanges the clipboard text through a UTF-8 temp file. */
async function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "whipdesk-clip-"));
  try {
    return await fn(join(dir, "clip.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pipe `text` to a command's stdin and wait for it to exit. */
function pipeTo(cmd: string, args: string[], text: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"], env });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin.on("error", () => {}); // EPIPE if the tool dies early — close() reports the cause
    child.stdin.end(text, "utf8");
  });
}

/** Current host clipboard TEXT ("" when empty or non-text, e.g. an image). */
export async function readClipboard(): Promise<string> {
  switch (process.platform) {
    case "darwin": {
      const { stdout } = await exec("pbpaste", [], { env: MAC_ENV, maxBuffer: MAX_BUFFER });
      return stdout;
    }
    case "win32":
      // Get-Clipboard's stdout rides the console codepage (mangles non-ASCII) and PowerShell
      // appends a newline — writing through .NET to a UTF-8 file avoids both.
      return withTempFile(async (file) => {
        await runPowerShell(
          `$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = '' }; ` +
            `[System.IO.File]::WriteAllText(${psQuote(file)}, $t)`,
        );
        return readFile(file, "utf8");
      });
    default: {
      const tool = linuxTool();
      if (!tool) throw new Error("no clipboard tool found (install wl-clipboard, xclip, or xsel)");
      const [cmd, args] = tool.read;
      // xclip/wl-paste exit non-zero on an EMPTY clipboard — that's "", not an error.
      const { stdout } = await exec(cmd, args, { maxBuffer: MAX_BUFFER }).catch(() => ({ stdout: "" }));
      return stdout;
    }
  }
}

/** Replace the host clipboard with `text`. */
export async function writeClipboard(text: string): Promise<void> {
  switch (process.platform) {
    case "darwin":
      await pipeTo("pbcopy", [], text, MAC_ENV);
      return;
    case "win32":
      await withTempFile(async (file) => {
        await writeFile(file, text, "utf8");
        await runPowerShell(
          `Set-Clipboard -Value ([System.IO.File]::ReadAllText(${psQuote(file)}, [System.Text.Encoding]::UTF8))`,
        );
      });
      return;
    default: {
      const tool = linuxTool();
      if (!tool) throw new Error("no clipboard tool found (install wl-clipboard, xclip, or xsel)");
      const [cmd, args] = tool.write;
      await pipeTo(cmd, args, text);
    }
  }
}
