#!/usr/bin/env node
/**
 * Multi-display smoke test. Connects, reads the display list from `welcome`, then asks the
 * agent to switch to each display and confirms a frame arrives for each.
 * Usage: node scripts/smoke-displays.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const port = "8787";
const token = readFileSync(new URL("../.whipdesk/token", import.meta.url), "utf8").trim();

const ws = new WebSocket(`ws://localhost:${port}/ws`);
ws.binaryType = "nodebuffer";

let displays = [];
let idx = 0;
let framesForCurrent = 0;
let timer;

const done = (code) => {
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(code);
};

const testNext = () => {
  if (idx >= displays.length) {
    console.log("all displays produced frames ✓");
    return done(0);
  }
  const d = displays[idx];
  framesForCurrent = 0;
  console.log(`switching to display [${d.id}] ${d.name} ${d.width}x${d.height}`);
  ws.send(JSON.stringify({ type: "select-display", id: d.id }));
};

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 1, token, role: "controller" })));

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    framesForCurrent += 1;
    if (framesForCurrent === 2) {
      console.log(`  frame ok (${data.length} bytes)`);
      idx += 1;
      testNext();
    }
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") {
    displays = msg.displays ?? [];
    console.log(`displays: ${JSON.stringify(displays.map((d) => `${d.id}:${d.name}`))}`);
    console.log(`active: ${msg.activeDisplay}`);
    testNext();
  }
});

ws.on("error", (e) => { console.error("ws error", e.message); done(1); });
timer = setTimeout(() => { console.error("timeout"); done(2); }, 15000);
