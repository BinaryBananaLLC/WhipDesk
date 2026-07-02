#!/usr/bin/env node
"use strict";
// SEA entry point (baked into the executable blob). The embedded Node runtime uses this to boot
// the REAL on-disk bundle at `<exeDir>/resources/app.cjs`. Keeping the app as an on-disk module —
// rather than baking it into the blob — is what makes its native/asset dependencies
// (ffmpeg-static, sharp, @nut-tree-fork/nut-js, werift, screenshot-desktop) resolve from the
// sibling `resources/node_modules` exactly as they would in a normal `npm install`. No per-package
// resolution shims needed.
const { createRequire } = require("node:module");
const path = require("node:path");

const appPath = path.join(path.dirname(process.execPath), "resources", "app.cjs");
try {
  createRequire(appPath)(appPath);
} catch (err) {
  console.error("WhipDesk: failed to load bundled app from", appPath);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
