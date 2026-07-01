import { execFile } from "node:child_process";
import { platform } from "node:os";

/** One running process, normalized across platforms. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Instantaneous %CPU (0 when the platform doesn't give it cheaply, e.g. Windows). */
  cpu: number;
  /** Controlling terminal ("?"/"" when none). */
  tty: string;
  command: string;
  /** Lowercased argv basenames, for agent matching. */
  tokens: string[];
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err && !stdout ? "" : stdout.toString());
    });
  });
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\s+/)) {
    if (!raw) continue;
    const base = (raw.split(/[\\/]/).pop() ?? raw).toLowerCase();
    if (base) out.push(base);
  }
  return out;
}

async function listUnix(): Promise<ProcInfo[]> {
  // `command` is last so its spaces never break the fixed-width columns before it.
  const out = await run("ps", ["-axww", "-o", "pid=,ppid=,pcpu=,tty=,command="]);
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const command = m[5]!.trim();
    if (!command) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]) || 0,
      tty: m[4]!,
      command,
      tokens: tokenize(command),
    });
  }
  return procs;
}

async function listWindows(): Promise<ProcInfo[]> {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Csv -NoTypeInformation";
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 9000);
  const procs: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"(\d+)","(\d*)",(.*)$/);
    if (!m) continue;
    let rest = m[3]!;
    // rest = "<commandLine or empty>","<name>"  — split off the trailing Name field.
    const nameMatch = rest.match(/,"([^"]*)"$/);
    let command = nameMatch ? rest.slice(0, rest.length - nameMatch[0].length) : rest;
    if (command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1);
    command = command.replace(/""/g, '"').trim();
    if (!command) command = nameMatch?.[1] ?? "";
    if (!command) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]) || 0,
      cpu: 0,
      tty: "",
      command,
      tokens: tokenize(command),
    });
  }
  return procs;
}

/** Snapshot of all processes (best-effort, never throws). */
export function listProcesses(): Promise<ProcInfo[]> {
  return platform() === "win32" ? listWindows() : listUnix();
}

/** Best-effort working directory of a pid (for a stable session key + locating transcripts). */
export async function processCwd(pid: number): Promise<string> {
  const os = platform();
  if (os === "win32") return "";
  if (os === "linux") {
    const out = await run("readlink", [`/proc/${pid}/cwd`], 2000);
    return out.trim();
  }
  // macOS: lsof reports the cwd file descriptor.
  const out = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], 3000);
  for (const line of out.split("\n")) if (line.startsWith("n")) return line.slice(1).trim();
  return "";
}
