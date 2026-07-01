const ts = () => new Date().toISOString().slice(11, 19);

// `--verbose`/`-v` surfaces internal capture/restart/ffmpeg chatter that is just noise during
// normal use. `log.debug` is silent unless it's on.
export const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

export const log = {
  info: (...args: unknown[]) => console.log(`[${ts()}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${ts()}] WARN`, ...args),
  error: (...args: unknown[]) => console.error(`[${ts()}] ERROR`, ...args),
  debug: (...args: unknown[]) => {
    if (verbose) console.log(`[${ts()}]`, ...args);
  },
};
