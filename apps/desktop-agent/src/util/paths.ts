import { createRequire } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the agent runs as a distributed build — either a Single Executable Application
 * (SEA, the self-contained downloads) or an installed npm package (`npm i -g whipdesk`) —
 * as opposed to a monorepo source checkout run via `tsx`.
 *
 * Distributed builds must not touch the (non-existent) source tree: state lives in the user's
 * home (see config.ts) so pairing/PIN/cloud identity survive updates. Env-free by design
 * (no process.env.WHIPDESK_*).
 */
export function isPackaged(): boolean {
  // Node SEA: the embedded runtime exposes `node:sea` with a truthy isSea().
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    if (typeof sea?.isSea === "function" && sea.isSea()) return true;
  } catch {
    /* not a SEA build, or an older Node without node:sea */
  }
  // Global/local npm install: this module lives inside a node_modules tree.
  try {
    return fileURLToPath(import.meta.url).includes(`${sep}node_modules${sep}`);
  } catch {
    return false;
  }
}
