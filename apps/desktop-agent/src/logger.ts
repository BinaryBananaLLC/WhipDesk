const ts = () => new Date().toISOString().slice(11, 19);

// `--verbose`/`-v` surfaces internal capture/restart/ffmpeg chatter that is just noise during
// normal use. `log.debug` is silent unless it's on.
export const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

// While an interactive terminal prompt owns the current line (startup sign-in "[y/N]:" etc.), an
// async log line — the update check, the HDR heads-up, a cloud reconnect — would print straight
// onto the prompt and mangle it (e.g. "…outside your local network? [y/N]: [07:20] update
// available…"). beginPrompt()/endPrompt() hold those lines and flush them once the answer is in.
let promptDepth = 0;
const pending: Array<() => void> = [];
function write(emit: (stamp: string) => void): void {
  const stamp = ts(); // capture the real time now, not at flush time
  if (promptDepth > 0) pending.push(() => emit(stamp));
  else emit(stamp);
}

export const log = {
  info: (...args: unknown[]) => write((s) => console.log(`[${s}]`, ...args)),
  warn: (...args: unknown[]) => write((s) => console.warn(`[${s}] WARN`, ...args)),
  error: (...args: unknown[]) => write((s) => console.error(`[${s}] ERROR`, ...args)),
  debug: (...args: unknown[]) => {
    if (verbose) write((s) => console.log(`[${s}]`, ...args));
  },
};

/** Suspend async log output while a readline prompt owns the terminal line. Nestable. */
export function beginPrompt(): void {
  promptDepth++;
}

/** Resume async log output and flush anything buffered while the prompt was open. */
export function endPrompt(): void {
  promptDepth = Math.max(0, promptDepth - 1);
  if (promptDepth === 0 && pending.length > 0) {
    const flush = pending.splice(0);
    for (const emit of flush) emit();
  }
}
