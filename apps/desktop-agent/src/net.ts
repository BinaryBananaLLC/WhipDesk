import { networkInterfaces, platform } from "node:os";
import qrcode from "qrcode-terminal";

// Cosmetic ASCII whip splashed once at startup.
const WHIP_ART = [
  "",
  "  .-.",
  "  |  \\",
  "   \\ |     |/_",
  "    '|     /`",
  "     |'._.'",
  "     |",
  "     |",
  "     #",
  "     #",
  "     #",
  "",
  "  WhipDesk",
  "",
];

/** Print the ASCII whip banner. */
export function printBanner(): void {
  console.log(WHIP_ART.join("\n"));
}

/** Best-effort LAN IPv4 for building the phone-reachable URL. */
export function getLanIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}

/**
 * Prints the connect URLs + a scannable QR. The URL embeds the pairing token in the
 * fragment (`#t=`), which is shown only on the operator's own console — never written
 * to request logs.
 */
export function printConnectInfo(port: number, token: string): void {
  const ip = getLanIp();
  const localUrl = `http://localhost:${port}/#t=${token}`;
  const netUrl = `http://${ip}:${port}/#t=${token}`;

  console.log("");
  console.log("  WhipDesk agent ready");
  console.log(`  Local:   ${localUrl}`);
  console.log(`  Network: ${netUrl}`);
  console.log("");
  console.log("  Scan the QR with your phone on the same Wi-Fi.");
  console.log("");
  qrcode.generate(netUrl, { small: true });
  console.log("");
}

/**
 * A short, platform-specific reminder of the OS permissions the agent needs to actually see the
 * screen and inject input. Reading the macOS TCC permission state from plain Node isn't reliable
 * without a native module, so we always print the concise reminder for the current platform (see
 * the README "Setup & permissions" section for the full walkthrough). If capture is genuinely
 * blocked at runtime, the capture pipeline additionally logs step-by-step help + a phone alert.
 */
export function printSetupReminder(): void {
  const lines: string[] = [];
  switch (platform()) {
    case "darwin":
      lines.push(
        "  macOS needs two permissions for the app that launched the agent (Terminal or VS Code):",
        "    - Screen Recording  ->  without it, frames show only the wallpaper.",
        "    - Accessibility     ->  without it, mouse and keyboard do nothing.",
        "  Grant both in System Settings > Privacy & Security, then FULLY quit and reopen that app.",
      );
      break;
    case "win32":
      lines.push(
        "  Windows: capture and input work out of the box. If the screen is black or clicks are",
        '  ignored on an admin/UAC window, relaunch this terminal via "Run as administrator".',
      );
      break;
    default: // linux and other unix
      lines.push(
        "  Linux: X11 sessions work out of the box. On Wayland, screen capture needs your desktop's",
        '  screen-share portal (xdg-desktop-portal), or log in under "X11/Xorg" instead of Wayland.',
      );
      break;
  }
  console.log("  Setup / permissions:");
  for (const line of lines) console.log(line);
  console.log("");
  console.log("  Troubleshooting: relaunch with --verbose (e.g. `whipdesk --verbose`) for detailed");
  console.log("  capture/network logs — attach them when reporting an issue.");
  console.log("");
}
