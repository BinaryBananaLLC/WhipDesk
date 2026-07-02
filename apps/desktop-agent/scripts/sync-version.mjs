// Writes src/version.ts from package.json "version" so the compiled/bundled agent reports the
// exact released version. Run before every bundle/publish (and by the release workflow after it
// bumps package.json to the release tag). Keeps package.json the single source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const versionPath = join(here, "..", "src", "version.ts");

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!version || typeof version !== "string") {
  throw new Error(`package.json has no usable "version": ${JSON.stringify(version)}`);
}

const body = `// Generated from package.json by scripts/sync-version.mjs — do not edit by hand.
// This is the single source of truth for the agent's reported version (welcome message +
// cloud device registry). The release workflow bumps package.json to the release tag, then
// re-runs the sync so the shipped binary reports the exact released version.
export const AGENT_VERSION = ${JSON.stringify(version)};
`;

writeFileSync(versionPath, body);
console.log(`sync-version: src/version.ts -> ${version}`);
