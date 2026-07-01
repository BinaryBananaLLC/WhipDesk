#!/usr/bin/env node
/**
 * Headless smoke test for the WhipDesk agent. Verifies: token handshake, welcome
 * payload (screen size + capabilities), and that binary JPEG frames actually flow.
 * Run while the agent is up:  node scripts/smoke.mjs
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";

const port = "8787";
const token = readFileSync(new URL("../.whipdesk/token", import.meta.url), "utf8").trim();

const ws = new WebSocket(`ws://localhost:${port}/ws`);
ws.binaryType = "nodebuffer";

let frames = 0;
let welcome = null;

const finish = (code) => {
  try {
    ws.close();
  } catch {}
  console.log(`result: welcome=${Boolean(welcome)} frames=${frames}`);
  process.exit(code);
};

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, token, role: "controller" }));
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    frames += 1;
    if (frames === 1) console.log(`first frame: ${data.length} bytes`);
    if (frames >= 3) finish(0);
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") {
    welcome = msg;
    console.log(`welcome screen=${JSON.stringify(msg.screen)} caps=${JSON.stringify(msg.capabilities)}`);
  } else if (msg.type === "notification") {
    console.log(`notification: ${msg.title} — ${msg.body ?? ""}`);
  }
});

ws.on("error", (error) => {
  console.error("ws error:", error.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("timeout waiting for frames");
  finish(2);
}, 8000);
