#!/usr/bin/env node
/**
 * Generic WhipDesk notifier. Posts to the agent's /api/notify webhook so connected
 * phones get a toast + system notification. This is the "AI is done" hook — append it
 * to any long-running command:
 *
 *   my-ai-cli run && node scripts/notify.mjs "AI done" "task complete" success
 *
 * Usage: node scripts/notify.mjs "<title>" ["<body>"] ["<level>"] ["<source>"]
 */
const [, , title = "WhipDesk", body = "", level = "info", source = "cli"] = process.argv;
const url = "http://localhost:8787/api/notify";

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
