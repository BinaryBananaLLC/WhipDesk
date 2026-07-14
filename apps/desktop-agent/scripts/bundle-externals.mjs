// The single source of truth for the agent bundle's EXTERNAL list — deps kept OUT of the esbuild
// bundle (build-bundle.mjs). Split into its own module (no esbuild import) so tooling that only
// needs the list can read it WITHOUT pulling in esbuild: check-install-clean.mjs runs in the CI
// `install-warnings` job, which deliberately skips `npm ci`, so devDeps like esbuild aren't present.
//
// Deps are external because they carry a native addon or a bundled binary/asset, resolve paths via
// __dirname, or use legacy syntax esbuild won't inline (qrcode-terminal's octal escapes). They
// resolve at runtime from node_modules: the user's for `npm i -g`, the sibling resources/node_modules
// for the SEA build (see build-sea.mjs).
//
// `@nut-tree-fork/nut-js` and `screenshot-desktop` are deliberately NOT here: they're pure JS (nut.js
// only needs the native libnut addons, which ARE external; screenshot-desktop just shells to the
// OS screengrabber), so we INLINE them. That keeps their deprecated transitive deps
// (jimp→…→phin, temp→rimraf→glob→inflight) out of the user's `npm i -g whipdesk` tree — those
// packages are no-longer-supported and print install-time warnings, but bundled into agent.cjs they
// are never installed. See the punycode alias in build-bundle.mjs, which finishes the job for
// nut.js/jimp.
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
