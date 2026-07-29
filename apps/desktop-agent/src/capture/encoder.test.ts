import assert from "node:assert/strict";
import test from "node:test";
import { parseAvScreenMap, selectAvScreenIndex } from "./encoder";

test("parses AVFoundation screen numbers independently of camera device indexes", () => {
  const devices = parseAvScreenMap(`
    [AVFoundation indev @ 0x1] AVFoundation video devices:
    [AVFoundation indev @ 0x1] [0] FaceTime HD Camera
    [AVFoundation indev @ 0x1] [2] Capture screen 0
    [AVFoundation indev @ 0x1] [3] Capture screen 1
  `);

  assert.deepEqual([...devices], [
    [0, "2"],
    [1, "3"],
  ]);
  assert.equal(selectAvScreenIndex(devices, 1), "3");
});

test("falls back to a currently available screen when a selected monitor disappeared", () => {
  const devices = new Map([[0, "2"]]);

  assert.equal(selectAvScreenIndex(devices, 1), "2");
  assert.equal(selectAvScreenIndex(new Map([[4, "7"]]), 1), "7");
  assert.equal(selectAvScreenIndex(new Map(), 1), null);
});
