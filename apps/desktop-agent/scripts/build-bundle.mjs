// Bundles the agent into a single CommonJS file (dist/agent.cjs) with a `#!/usr/bin/env node`
// shebang. Pure-JS deps are inlined; native/asset deps (EXTERNAL) stay external so they resolve
// from node_modules at runtime — for `npm i -g whipdesk` that's the user's install; for the
// SEA build it's the sibling resources/node_modules (see build-sea.mjs). This file is the npm `bin`
// and is (re)built by `prepublishOnly`.
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);

// Deps kept OUT of the JS bundle — because they carry a native addon or a bundled binary/asset,
// resolve paths via __dirname, or use legacy syntax esbuild won't inline (qrcode-terminal's octal
// escapes). They resolve at runtime from node_modules: the user's for `npm i -g`, the sibling
// resources/node_modules for the SEA build (see build-sea.mjs).
//
// `@nut-tree-fork/nut-js` and `screenshot-desktop` are deliberately NOT here: they're pure JS (nut.js
// only needs the native libnut addons, which ARE external; screenshot-desktop just shells to the
// OS screengrabber), so we INLINE them. That keeps their deprecated transitive deps
// (jimp→…→phin, temp→rimraf→glob→inflight) out of the user's `npm i -g whipdesk` tree — those
// packages are no-longer-supported and print install-time warnings, but bundled into agent.cjs they
// are never installed. See the punycode alias below, which finishes the job for nut.js/jimp.
//
// libnut is externalized as the three PLATFORM addon packages, NOT the `@nut-tree-fork/libnut`
// meta wrapper: the wrapper is pure JS but requires `@nut-tree-fork/shared` (→ jimp) at runtime
// WITHOUT declaring it (upstream bug) — kept external it loads in a dev checkout (nut-js devDep
// tree provides shared) but throws on a clean `npm i -g whipdesk`, silently downgrading input to
// keyboard-only. Declaring shared would reinstall the deprecated jimp tree, so instead the wrapper
// is inlined (its shared/jimp requires bundle with it) and only the true native addons resolve
// from node_modules. package.json optionalDependencies must mirror the libnut-* list below.
export const EXTERNAL = [
  "ffmpeg-static",
  "sharp",
  "@nut-tree-fork/libnut-darwin",
  "@nut-tree-fork/libnut-linux",
  "@nut-tree-fork/libnut-win32",
  "werift",
  "qrcode-terminal",
];

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(agentDir, "..", "..");

// Copy the repo-root README into the package, rewriting relative markdown links (`](docs/…)`,
// `](LICENSE)`) to absolute GitHub URLs. Absolute links (https://…), anchors (#…) and mailto: are
// left alone. This keeps ONE README that renders correctly on both github.com and npmjs.com.
function mirrorReadme() {
  const BLOB = "https://github.com/BinaryBananaLLC/WhipDesk/blob/main/";
  const src = readFileSync(join(repoRoot, "README.md"), "utf8");
  const rewritten = src.replace(/\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g, (_m, target) => `](${BLOB}${target})`);
  writeFileSync(join(agentDir, "README.md"), rewritten);
}

export async function buildBundle() {
  // Version single-source: package.json -> src/version.ts.
  const r = spawnSync(process.execPath, ["scripts/sync-version.mjs"], { stdio: "inherit", cwd: agentDir });
  if (r.status !== 0) throw new Error(`sync-version -> exit ${r.status}`);

  // README single-source: mirror the repo-root README onto the npm package so npmjs.com shows the
  // SAME docs as GitHub (there is no second README to drift). Relative links (docs/…, LICENSE) are
  // rewritten to absolute repo URLs so they resolve on the npm page. Generated (gitignored), run by
  // prepublishOnly, so it's always in sync at publish time.
  mirrorReadme();

  // The agent serves the controller PWA over LAN, so ship the built mobile-web NEXT TO the bundle
  // (dist/mobile-web). server.ts resolves it there in a packaged build.
  // shell:true on Windows — `npm` there is `npm.cmd`, which spawnSync can't launch without a shell
  // (it returns status:null). node/esbuild run direct.
  const web = spawnSync("npm", ["run", "build", "--workspace", "@whipdesk/mobile-web"], {
    stdio: "inherit",
    cwd: repoRoot,
    shell: process.platform === "win32",
  });
  if (web.error) throw new Error(`mobile-web build -> ${web.error.message}`);
  if (web.status !== 0) throw new Error(`mobile-web build -> exit ${web.status}`);
  const webOut = join(agentDir, "dist/mobile-web");
  rmSync(webOut, { recursive: true, force: true });
  cpSync(join(repoRoot, "apps/mobile-web/dist"), webOut, { recursive: true });

  await esbuild.build({
    entryPoints: [join(agentDir, "src/index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(agentDir, "dist/agent.cjs"),
    external: EXTERNAL,
    // jimp (inlined via nut.js) reaches whatwg-url, which does `require("punycode")` at load. Bare
    // "punycode" resolves to Node's BUILTIN, which prints a [DEP0040] deprecation warning at runtime.
    // Redirect it to the maintained userland `punycode` package (a devDep) so esbuild inlines that
    // instead — no builtin access, no warning. (Only the builtin is deprecated; the npm package is
    // the reference implementation and is fine.)
    alias: { punycode: require.resolve("punycode/") },
    // `import.meta.url` has no meaning in a CJS bundle (esbuild would leave it undefined), but
    // paths.ts/optional-import.ts rely on it to anchor module resolution + detect a packaged build.
    // Point it at the bundle file itself (CJS __filename) so createRequire resolves from the sibling
    // node_modules — correct for both the SEA (resources/app.cjs) and npm-install layouts. Under
    // tsx (dev, real ESM) the define doesn't apply and the native value is used.
    banner: { js: "#!/usr/bin/env node\nconst __whipdesk_meta_url = require('url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__whipdesk_meta_url" },
    tsconfig: join(agentDir, "tsconfig.json"),
    logLevel: "info",
  });
  console.log("build-bundle: dist/agent.cjs written");
}

// Run when invoked directly (npm run build:bundle / prepublishOnly).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildBundle().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
