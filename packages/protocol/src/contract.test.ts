import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, PROTOCOL_VERSION } from "./index";

// The wire contract. These values are shared by the agent and the controller; changing one
// without the other breaks every connection, so pin them down here.
test("protocol version is the expected wire version", () => {
  assert.equal(PROTOCOL_VERSION, 3);
});

test("network defaults are stable (changing these is a compatibility change)", () => {
  assert.equal(DEFAULTS.PORT, 8787);
  assert.equal(DEFAULTS.FPS, 10);
  assert.equal(DEFAULTS.JPEG_QUALITY, 75);
  assert.equal(DEFAULTS.MAX_WIDTH, 2048);
});
