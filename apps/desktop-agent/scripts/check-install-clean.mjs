// Release gate: guarantees `npm install -g whipdesk` shows users NO warnings and errors.
//
// Why this exists: anyone installing from npm sees every `npm warn deprecated` in the package's
// PRODUCTION dependency closure (dependencies + optionalDependencies — devDeps are never installed
// by consumers). A SINGLE deprecated transitive dep is enough to spray scary warnings on install:
// `screenshot-desktop` dragged in temp -> rimraf@2 -> glob@7 -> inflight, and `@nut-tree-fork/nut-js`
// dragged in jimp -> load-bmfont -> phin — together four deprecation warnings. The fix inlines those
// two pure-JS deps into the esbuild bundle (build-bundle.mjs) so they are never installed; THIS
// script makes sure they — or anything like them — never creep back into the shipped tree.
//
// How: pack the real package, install the tarball into a throwaway project with ONLY production
// deps, and fail if npm emits any deprecation warning. `--ignore-scripts` keeps it fast and
// hermetic — deprecation notices come from registry metadata during resolution, BEFORE any native
// postinstall — so there are no per-platform binary downloads and the result is deterministic.
// Deprecation status is per package@version (not per OS/CPU), so one run represents every platform.
// brew/scoop/winget ship the pre-built SEA (deps pre-bundled in resources/node_modules), so npm is
// the only channel that runs an install in front of users — this gate covers it.
//
// Run locally:  npm run check:install-clean --workspace whipdesk

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));

// npm is a `.cmd` shim on Windows, which spawnSync can't launch without a shell (returns status:null).
const npmShell = process.platform === "win32";
function npm(args, cwd) {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", shell: npmShell });
  if (r.error) throw new Error(`npm ${args.join(" ")} -> ${r.error.message}`);
  return { code: r.status ?? 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const work = mkdtempSync(join(tmpdir(), "whipdesk-installcheck-"));
const consumer = join(work, "consumer");
mkdirSync(consumer, { recursive: true });

try {
  // 1) Pack the package exactly as it would publish. Its production deps come from THIS package.json,
  //    so a missing dist/ (this may run before a build) doesn't affect the dependency tree we test.
  const packed = npm(["pack", "--pack-destination", work, "--silent"], agentDir);
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    console.error(`check-install-clean: \`npm pack\` produced no tarball (exit ${packed.code})\n${packed.out}`);
    process.exit(1);
  }

  // 2) Install the tarball into a throwaway consumer with ONLY production deps — exactly what
  //    `npm install -g whipdesk` resolves. --ignore-scripts skips native postinstalls but STILL
  //    reports every deprecation from the resolved tree.
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "whipdesk-install-check", version: "0.0.0", private: true }, null, 2),
  );
  const res = npm(
    ["install", join(work, tgz), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "warn"],
    consumer,
  );

  // 3) Any `npm warn deprecated ...` line means a user would see it on install. (Case-insensitive:
  //    older npm prints `npm WARN deprecated`.)
  const warnings = res.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /npm warn deprecated/i.test(l));

  if (warnings.length > 0) {
    console.error(
      `\n\u2716 ${pkg.name}@${pkg.version} would show ${warnings.length} deprecation warning(s) on ` +
        `\`npm install -g ${pkg.name}\`:\n`,
    );
    for (const w of warnings) console.error("  " + w);
    console.error(
      "\nUsers must NOT see these. Remove the offending dependency from the published tree" +
        "\n(dependencies/optionalDependencies): inline a pure-JS dep into the esbuild bundle" +
        "\n(apps/desktop-agent/scripts/build-bundle.mjs), or upgrade/replace it. Trace the source with:" +
        `\n  npm explain <package> --workspace ${pkg.name}\n`,
    );
    process.exit(1);
  }

  if (res.code !== 0) {
    console.error(`check-install-clean: install failed (exit ${res.code})\n${res.out}`);
    process.exit(res.code);
  }

  console.log(
    `\u2713 ${pkg.name}@${pkg.version}: production install tree is clean \u2014 ` +
      `no deprecation warnings for \`npm install -g ${pkg.name}\`.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
