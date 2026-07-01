import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinGuard, responseFor, stretch } from "./pin";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("stretch is a deterministic salted sha256 chain", () => {
  assert.equal(stretch("1234", "salt", 3), sha(sha(sha("salt:1234"))));
  assert.equal(stretch("1234", "salt", 3), stretch("1234", "salt", 3));
  assert.notEqual(stretch("1234", "salt", 3), stretch("1235", "salt", 3));
  assert.notEqual(stretch("1234", "salt", 3), stretch("1234", "other", 3));
  assert.notEqual(stretch("1234", "salt", 3), stretch("1234", "salt", 4));
});

test("responseFor binds the key to the nonce", () => {
  assert.equal(responseFor("key", "nonce"), sha("key:nonce"));
  assert.notEqual(responseFor("key", "n1"), responseFor("key", "n2"));
});

test("PinGuard accepts the right response and rejects wrong/empty ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-pin-"));
  try {
    const guard = PinGuard.load(dir);
    guard.setPin("4242");
    assert.equal(guard.isSet, true);

    const key = stretch("4242", guard.salt, guard.iterations);
    const nonce = guard.issueNonce();
    assert.equal(guard.verify(nonce, responseFor(key, nonce)), true);

    const wrong = stretch("0000", guard.salt, guard.iterations);
    assert.equal(guard.verify(nonce, responseFor(wrong, nonce)), false);
    assert.equal(guard.verify(nonce, ""), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset PinGuard is open (no PIN configured)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-pin-"));
  try {
    const guard = PinGuard.load(dir);
    assert.equal(guard.isSet, false);
    assert.equal(guard.verify("nonce", "anything"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
