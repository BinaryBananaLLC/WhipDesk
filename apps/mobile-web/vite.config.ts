import { defineConfig } from "vite";

// Relative base ("./") so the SAME build works served at "/" (by the desktop-agent on LAN)
// and under "/app/" (by whipdesk.com for remote WebRTC mode).
export default defineConfig({
  base: "./",
  server: { host: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
