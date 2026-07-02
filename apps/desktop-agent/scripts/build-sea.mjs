// Builds a Single Executable Application (SEA) for the HOST platform:
//
//   dist/stage/
//     whipdesk[.exe]              <- stock Node runtime + our SEA loader blob (embedded)
//     resources/
//       app.cjs                   <- esbuild bundle of the agent (pure-JS deps inlined)
//       node_modules/             <- ONLY the native/asset deps, installed for this platform
//                                    (ffmpeg-static + its ffmpeg binary, sharp, nut.js, werift,
//                                     screenshot-desktop)
//
// The loader boots resources/app.cjs so those deps resolve like a normal install (see
// scripts/sea-loader.cjs). Signing / notarization / .pkg / archiving are layered on top of
// dist/stage by the release workflow. Run locally for testing: `node scripts/build-sea.mjs`.
//
// Cross-compilation is intentionally NOT attempted: native addons + the ffmpeg binary are
// per-platform and SEA code-cache isn't portable, so each OS/arch is built on its own runner.

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL, buildBundle } from "./build-bundle.mjs";

const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(agentDir, "dist");
const stageDir = join(distDir, "stage");
const resourcesDir = join(stageDir, "resources");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exeName = isWin ? "whipdesk.exe" : "whipdesk";
const exePath = join(stageDir, exeName);

const pkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));

// Preflight: some Node builds (notably Homebrew) omit the SEA fuse sentinel, so postject later
// fails with a cryptic "Could not find the sentinel". Fail fast with a fix instead.
if (!readFileSync(process.execPath).includes(SENTINEL)) {
  throw new Error(
    `This Node build lacks SEA support (no fuse in ${process.execPath}).\n` +
      `Homebrew's Node is known to omit it. Use the official installer from nodejs.org, or the\n` +
      `pinned actions/setup-node in the release workflow (which the CI build uses).`,
  );
}

function run(cmd, args, opts = {}) {
  // Windows can't spawn npm/npx directly (they're `.cmd` shims) — they need a shell, which returns
  // status:null otherwise. `node`/`codesign` are real executables and run without one.
  const shell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: agentDir, shell, ...opts });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")} -> ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> exit ${r.status}`);
}

// 1) Version single-source + bundle (pure-JS deps inlined; native/asset deps external).
rmSync(distDir, { recursive: true, force: true });
await buildBundle();
mkdirSync(resourcesDir, { recursive: true });
copyFileSync(join(distDir, "agent.cjs"), join(resourcesDir, "app.cjs"));
cpSync(join(distDir, "mobile-web"), join(resourcesDir, "mobile-web"), { recursive: true }); // LAN controller PWA

// 3) Install ONLY the external deps into resources/node_modules for THIS platform (runs the
//    ffmpeg-static / sharp / nut.js install scripts that fetch per-platform binaries).
const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
const stageManifest = {
  name: "whipdesk-resources",
  private: true,
  version: pkg.version,
  dependencies: Object.fromEntries(EXTERNAL.map((n) => [n, deps[n] ?? "*"])),
};
writeFileSync(join(resourcesDir, "package.json"), JSON.stringify(stageManifest, null, 2));
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: resourcesDir });

// 4) Build the SEA blob and inject it into a copy of the running Node runtime.
run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);
copyFileSync(process.execPath, exePath);
chmodSync(exePath, 0o755); // the source `node` binary is 0555; postject needs owner-write

if (isMac) run("codesign", ["--remove-signature", exePath]); // re-signed below / in CI

const postjectArgs = [
  "postject",
  exePath,
  "NODE_SEA_BLOB",
  join(distDir, "sea-prep.blob"),
  "--sentinel-fuse",
  SENTINEL,
];
if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
run("npx", ["--no-install", ...postjectArgs]);

// Ad-hoc sign so the binary at least runs locally; CI re-signs with the Developer ID cert.
if (isMac) run("codesign", ["--sign", "-", "--force", "--options", "runtime", "--entitlements", "packaging/entitlements.plist", exePath]);

console.log(`\nSEA staged at: ${stageDir}`);
console.log(`Run it:        ${exePath}`);
if (!existsSync(join(resourcesDir, "node_modules", "ffmpeg-static"))) {
  console.warn("WARNING: ffmpeg-static missing from resources/node_modules — screen sharing will be unavailable.");
}
