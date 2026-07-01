import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inferState, DEFAULT_THRESHOLDS, type Sample } from "./state.ts";

const base: Sample = { present: true, cpu: 0, subtreeCpu: 0, activityAgeMs: null };

test("high CPU => working", () => {
  assert.equal(inferState("idle", { ...base, cpu: 40 }), "working");
});

test("busy child process => working even with a stale transcript", () => {
  // A long build/test/install: the agent itself is idle but its subprocess is burning CPU.
  assert.equal(inferState("working", { ...base, cpu: 1, subtreeCpu: 70, activityAgeMs: 60_000 }), "working");
});

test("fresh transcript => working even at low CPU", () => {
  assert.equal(inferState("idle", { ...base, cpu: 1, activityAgeMs: 1000 }), "working");
});

test("recent-but-stopped activity, idle subtree => blocked (awaiting you)", () => {
  assert.equal(inferState("working", { ...base, cpu: 1, subtreeCpu: 1, activityAgeMs: 30_000 }), "blocked");
});

test("long-quiet => idle", () => {
  assert.equal(inferState("blocked", { ...base, cpu: 0, activityAgeMs: 5 * 60_000 }), "idle");
});

test("no transcript + nothing busy => idle", () => {
  assert.equal(inferState("working", { ...base, cpu: 0, activityAgeMs: null }), "idle");
});

test("disappears while working => crashed", () => {
  assert.equal(inferState("working", { ...base, present: false }), "crashed");
});

test("disappears while idle => finished", () => {
  assert.equal(inferState("idle", { ...base, present: false }), "finished");
});

test("thresholds are sane", () => {
  assert.ok(DEFAULT_THRESHOLDS.workingFreshMs < DEFAULT_THRESHOLDS.blockedWindowMs);
  assert.ok(DEFAULT_THRESHOLDS.blockedConfirmMs > 0);
  assert.ok(DEFAULT_THRESHOLDS.idleConfirmMs > 0);
});
