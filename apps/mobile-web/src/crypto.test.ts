import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { responseFor, sha256Hex, stretch } from "./crypto";

// The controller stretches the PIN with a tiny pure-JS sha256 (crypto.subtle is unavailable on
// the non-secure http LAN origin). It MUST match Node's createHash byte-for-byte, or the agent —
// which verifies with node:crypto — would reject every login. These tests lock that in.
const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("pure sha256Hex matches Node's crypto byte-for-byte", () => {
  for (const s of ["", "a", "abc", "hello world", "salt:1234", "\u2713 unicode \ud83d\udd12", "x".repeat(1000)]) {
    assert.equal(sha256Hex(s), nodeSha(s));
  }
});

test("stretch + responseFor match the agent's construction", () => {
  assert.equal(stretch("1234", "salt", 3), nodeSha(nodeSha(nodeSha("salt:1234"))));
  assert.equal(stretch("1234", "salt", 1), nodeSha("salt:1234"));
  assert.equal(responseFor("k", "n"), nodeSha("k:n"));
});
