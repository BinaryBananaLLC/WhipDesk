#!/usr/bin/env node
/**
 * Region-capture smoke (Phase 1). After auth, advertise that the host can crop (welcome
 * capability), send a `set-viewport` for the centre quarter of the screen, and confirm the host
 * echoes the clamped region back via `screen-region` and keeps sending frames.
 *
 * Usage: node scripts/smoke-viewport.mjs [pin]
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const port = "8787";
const pin = process.argv[2] ?? "";
const token = readFileSync(new URL("../.whipdesk/token", import.meta.url), "utf8").trim();

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const stretch = (p, salt, it) => {
  let h = sha(`${salt}:${p}`);
  for (let i = 1; i < it; i++) h = sha(h);
  return h;
};
const respFor = (key, nonce) => sha(`${key}:${nonce}`);

const ws = new WebSocket(`ws://localhost:${port}/ws`);
ws.binaryType = "nodebuffer";
let region = null;
let frames = 0;
let regionCapable = null;

const done = (ok, msg) => {
  try { ws.close(); } catch {}
  console.log(msg);
  console.log(ok ? "viewport smoke: PASS ✓" : "viewport smoke: FAIL ✗");
  process.exit(ok ? 0 : 1);
};

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 1, token, role: "controller" })));
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    frames += 1;
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "auth-required") {
    if (!pin) return done(false, "PIN required — pass it: node scripts/smoke-viewport.mjs <pin>");
    const key = stretch(pin, msg.salt, msg.iterations);
    ws.send(JSON.stringify({ type: "auth", response: respFor(key, msg.nonce) }));
  } else if (msg.type === "welcome") {
    regionCapable = Boolean(msg.capabilities?.region);
    ws.send(JSON.stringify({ type: "set-viewport", x: 0.25, y: 0.25, w: 0.5, h: 0.5 }));
  } else if (msg.type === "screen-region") {
    region = msg;
  }
});
ws.on("error", (e) => done(false, `ws error: ${e.message}`));

setTimeout(() => {
  const ok =
    !!region &&
    Math.abs(region.x - 0.25) < 0.01 &&
    Math.abs(region.y - 0.25) < 0.01 &&
    Math.abs(region.w - 0.5) < 0.01 &&
    Math.abs(region.h - 0.5) < 0.01 &&
    frames > 0;
  done(ok, `regionCapable=${regionCapable} echo=${JSON.stringify(region)} frames=${frames}`);
}, 3000);
