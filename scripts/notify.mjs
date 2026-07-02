#!/usr/bin/env node
/**
 * Generic WhipDesk notifier. Posts to the agent's /api/notify webhook so connected
 * phones get a toast + system notification. This is the "AI is done" hook — append it
 * to any long-running command:
 *
 *   my-ai-cli run && node scripts/notify.mjs "AI done" "task complete" success
 *
 * The endpoint requires the pairing token (so nothing else on your LAN can spoof
 * notifications); this script reads it from the agent's state dir automatically.
 *
 * Usage: node scripts/notify.mjs "<title>" ["<body>"] ["<level>"] ["<source>"]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , title = "WhipDesk", body = "", level = "info", source = "cli"] = process.argv;
const url = "http://localhost:8787/api/notify";

// Same resolution order as the agent: repo state dir for a source checkout, ~/.whipdesk otherwise.
function readToken() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const p of [join(repoRoot, ".whipdesk", "token"), join(homedir(), ".whipdesk", "token")]) {
    try {
      const token = readFileSync(p, "utf8").trim();
      if (token) return token;
    } catch {
      /* try the next location */
    }
  }
  return "";
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${readToken()}` },
    body: JSON.stringify({ title, body, level, source }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    console.error(`notify failed: HTTP ${res.status}`, json);
    process.exit(1);
  }
  console.log(`notified: ${json.id}`);
} catch (error) {
  console.error("notify error:", error.message);
  console.error(`(is the agent running on ${url}?)`);
  process.exit(1);
}
