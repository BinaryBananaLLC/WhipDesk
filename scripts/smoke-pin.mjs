#!/usr/bin/env node
/**
 * PIN handshake smoke test. Starts a controller, answers the agent's auth-required challenge
 * with the same KDF the browser uses, and confirms welcome + frames flow. Also checks that a
 * wrong PIN is rejected. Set the agent's PIN interactively at startup, then pass the same PIN here.
 *
 * Usage: node scripts/smoke-pin.mjs [pin]   (pin defaults to 1234)
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const port = "8787";
const pin = process.argv[2] ?? "1234";
const token = readFileSync(new URL("../.whipdesk/token", import.meta.url), "utf8").trim();

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const stretch = (p, salt, it) => {
  let h = sha(`${salt}:${p}`);
  for (let i = 1; i < it; i++) h = sha(h);
  return h;
};
const respFor = (key, nonce) => sha(`${key}:${nonce}`);

function attempt(usePin, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.binaryType = "nodebuffer";
    let got = { welcome: false, frames: 0, error: null };
    const done = (verdict) => {
      try { ws.close(); } catch {}
      resolve({ label, verdict, ...got });
    };
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 1, token, role: "controller" })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        got.frames += 1;
        if (got.frames >= 1) done("welcome+frames");
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === "auth-required") {
        const key = stretch(usePin, msg.salt, msg.iterations);
        ws.send(JSON.stringify({ type: "auth", response: respFor(key, msg.nonce) }));
      } else if (msg.type === "welcome") {
        got.welcome = true;
      } else if (msg.type === "error") {
        got.error = msg.code;
        if (msg.code === "pin-locked" || msg.code === "auth") done(`rejected:${msg.code}`);
      }
    });
    ws.on("error", (e) => { got.error = e.message; done("ws-error"); });
    setTimeout(() => done("timeout"), 6000);
  });
}

const good = await attempt(pin, "correct PIN");
console.log("correct PIN  ->", good.verdict, `(welcome=${good.welcome}, frames=${good.frames})`);
const bad = await attempt("0000", "wrong PIN");
console.log("wrong PIN    ->", bad.verdict, `(error=${bad.error})`);

const ok = good.welcome && good.frames > 0 && !bad.welcome;
console.log(ok ? "PIN smoke: PASS ✓" : "PIN smoke: FAIL ✗");
process.exit(ok ? 0 : 1);
