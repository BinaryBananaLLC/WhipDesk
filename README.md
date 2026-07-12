# WhipDesk

> Control your desktop — and the AI coding agents running on it — from any phone browser.

[![CI](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BinaryBananaLLC/WhipDesk)](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest)
[![GitHub downloads](https://img.shields.io/github/downloads/BinaryBananaLLC/WhipDesk/total)](https://github.com/BinaryBananaLLC/WhipDesk/releases)
[![npm](https://img.shields.io/npm/dm/whipdesk)](https://www.npmjs.com/package/whipdesk)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/BinaryBananaLLC/WhipDesk/badge)](https://scorecard.dev/viewer/?uri=github.com/BinaryBananaLLC/WhipDesk)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

WhipDesk turns any mobile browser into a remote control for your dev machine. See the screen,
move the mouse, type, paste prompts into your AI tools, and get a push notification the moment a
long-running build or agent job finishes — no app store install, no kernel extension, no agent
running on your phone.

Because it's **screen-level**, it works with *every* AI agent — Claude Code and Codex in a
terminal, Copilot Chat inside VS Code, Cursor, a browser tab running tests — with **no wrappers
and no hooks required**: you never change how you launch your tools. CLI-wrapper apps only see
the one agent they wrap; WhipDesk sees your actual desktop.

It's peer-to-peer: an encrypted WebRTC connection that talks **directly** between phone and
desktop, on your LAN or across the internet. The cloud only brokers the initial handshake — your
screen and keystrokes never flow through anyone else's server.

## Features

- **Live screen, tuned for mobile data** — direct H.264, hardware-encoded. When you zoom, the
  host **re-crops the encode to just your phone's viewport**, so a magnified terminal costs a
  fraction of the bandwidth of streaming the whole desktop — full-desktop streamers (RustDesk,
  Parsec, Chrome Remote Desktop) always ship every pixel. A quality ladder steps the bitrate
  down automatically on a lossy cellular link, and encoding pauses entirely while your phone's
  screen is off.
- **AI-agent monitoring (auto-whips)** — the host detects running agents (Claude Code, Codex,
  Gemini CLI, Aider, Copilot — including Copilot Chat inside VS Code — opencode, Cursor, Amp) by
  observing processes and transcripts, and pings your phone the moment one stops working: waiting
  on you, finished, or crashed. Zero config; optional [agent-native hooks](docs/HOOKS.md) make the
  alert instant.
- **Full input** — mouse, touch, and keyboard injected into the real OS; built for poking at
  AI agents and CLIs from your couch.
- **LashStash** — record reusable multi-step automations ("lashes": click → type a prompt →
  Enter, waits, key presses…), then run one instantly with a 3-second countdown or schedule it
  for when a session limit resets. Lashes are stored on the host machine (their coordinates are
  tied to its screens) and survive agent updates.
- **Job-done notifications** — a token-authenticated webhook (`POST /api/notify`) or an opt-in
  file watcher fires a notification when a slow task completes; optional background push to a
  closed PWA via FCM.
- **Private by design** — DTLS-encrypted P2P media, a PIN challenge on **every** connection (the
  PIN itself never crosses the wire), a pairing token underneath, and persistent brute-force
  lockout. Secrets stay on your machine. See [SECURITY.md](SECURITY.md) for the threat model.
- **No account needed on LAN** — cloud (remote access, device dashboard) is strictly opt-in.

## Quick start (macOS)

```bash
npm install
npm run dev          # builds the web controller, then starts the desktop agent
```

The agent prints a `http://<lan-ip>:8787/#t=<token>` URL and a QR code. Open it on your phone
(same Wi-Fi), then grant the launching terminal app **Screen Recording** and **Accessibility**
in System Settings → Privacy & Security, and restart it. Without those, frames show only the
wallpaper and input does nothing.

Fire a test notification:

```bash
npm run notify -- "Build done" "tsc finished with 0 errors"
```

> Tested on macOS (Apple Silicon). The capture/input stack is cross-platform, but Windows and
> Linux hosts aren't verified yet.

## Install a prebuilt agent

You don't have to build from source. Every [release](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest)
is built by GitHub Actions straight from the tagged source, with
[verifiable build provenance](docs/VERIFYING-DOWNLOADS.md).

**One-liners** ([install.sh](scripts/install/install.sh) / [install.ps1](scripts/install/install.ps1) —
they download the signed release for your OS, verify its SHA-256, and install it):

macOS / Linux:

```bash
curl -fsSL https://whipdesk.com/install.sh | bash
```

Windows (PowerShell):

```powershell
powershell -c "irm https://whipdesk.com/install.ps1 | iex"
```

**Homebrew (macOS).**

```bash
brew install --cask BinaryBananaLLC/whipdesk/whipdesk
whipdesk
```

**Self-contained download (no Node needed).** Grab the package for your OS:

| OS | Asset | Notes |
| --- | --- | --- |
| macOS | `whipdesk-<ver>-macos-arm64.pkg` / `-x64.pkg` | Signed with a Developer ID & **notarized** — installs `whipdesk` to your PATH. |
| Windows | `whipdesk-<ver>-windows-x64-setup.exe` | Setup wizard — installs per-user, no admin needed. |
| Windows | `whipdesk-<ver>-windows-x64.zip` | Portable: unzip and run `whipdesk.exe` (also available via Scoop). |
| Linux | `whipdesk-<ver>-linux-x64.tar.gz` | Extract and run `./whipdesk` (needs X11). |

**npm (if you already have Node ≥ 20):**

```bash
npm install -g whipdesk
whipdesk
```

The npm package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(the verified badge on npmjs.com links back to the exact build).

Prebuilt agents keep their pairing/PIN state in `~/.whipdesk`, so updates don't re-pair you.
**Always verify a download before running it** — see [docs/VERIFYING-DOWNLOADS.md](docs/VERIFYING-DOWNLOADS.md).

WhipDesk tells you (in the running agent, on your connected phone, and on the dashboard) when a new
version ships — it never auto-updates. See **[docs/UPDATING.md](docs/UPDATING.md)** for the one-line
update command per install method and how the notifications work.

**Uninstall.** Remove the package the same way you installed it (`npm uninstall -g whipdesk`,
`brew uninstall --cask whipdesk`, the Windows uninstaller, …). Saved state — pairing token, access
PIN, cloud sign-in — lives in `~/.whipdesk` and is *not* removed automatically (npm no longer runs
uninstall scripts). For a clean slate, also run `rm -rf ~/.whipdesk`
(Windows: `Remove-Item -Recurse ~\.whipdesk`).

## Setup & permissions (troubleshooting)

The agent prints a short reminder for your OS at startup. If the screen shows only your wallpaper,
or the mouse/keyboard don't respond, it's almost always an OS permission — here's the fix per
platform:

**macOS** — grant the app that *launched* the agent (Terminal, iTerm, or VS Code), not "node":

1. **Screen Recording** — System Settings → Privacy & Security → Screen Recording → enable the app.
   Without it, frames show only the wallpaper.
2. **Accessibility** — System Settings → Privacy & Security → Accessibility → enable the app.
   Without it, mouse and keyboard input do nothing.
3. **Fully quit and reopen** that app (a plain window-close isn't enough), then run it again.

   Shortcut to the right pane: `open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`

**Windows** — capture and input work out of the box. If the screen is black or clicks are ignored
on an elevated window (a UAC prompt or an app "Run as administrator"), relaunch your terminal via
**Run as administrator** so the agent can see and drive those windows.

**Linux** — X11 sessions work out of the box. On **Wayland**, screen capture is gated behind the
desktop's screen-share portal: install/enable `xdg-desktop-portal` (plus your compositor's backend,
e.g. `xdg-desktop-portal-wlr` or `-gnome`), or log in under an **X11/Xorg** session instead of
Wayland. Input injection also needs access to `/dev/uinput` on some setups.

If capture is genuinely blocked, the agent also logs step-by-step help and pushes a
"Screen capture blocked" alert to your phone.

### Verbose logs (for bug reports)

When something misbehaves — a black or frozen screen, a capture that keeps restarting, a
connection that won't form — re-run the agent with `--verbose` and share the output when you open
an issue. It surfaces the capture/encoder/ffmpeg and transport chatter that's hidden in normal use.

- **Prebuilt binary** (Scoop / direct download): `whipdesk --verbose`
- **From source**: `npm run whipdesk:verbose` (or `npm run dev` to rebuild the controller first)

Copy the console output from startup through the moment the problem happens into your
[GitHub issue](https://github.com/BinaryBananaLLC/WhipDesk/issues). The only secret shown is the
pairing token in the connect URL — redact the `#t=…` fragment before sharing.

### Windows screen capture & HDR

On Windows the agent captures with the GPU **Desktop Duplication API** (ddagrab), which stays fast
at 4K and captures **HDR** desktops correctly. On old Windows builds or GPUs without Direct3D 11 it
falls back automatically to the legacy `gdigrab` grabber — that path can't read an HDR framebuffer,
so if the screen there is black or full of artifacts, update your graphics driver or turn HDR off in
**Settings → System → Display**.

## How it works

A **desktop agent** (Node) captures the screen, injects input, and serves the **web controller**
(a framework-light vanilla-TS PWA). They speak one message contract
([`packages/protocol`](packages/protocol)) over WebRTC — one DataChannel for control plus H.264
video tracks, all DTLS-encrypted — with two ways to broker the handshake:

- **LAN** — the agent's own WebSocket swaps the SDP offer/answer; the media flows host-to-host
  on your network, touching nothing else.
- **Remote** — a WebSocket to the WhipDesk edge (Cloudflare) swaps the SDP; STUN connects
  directly, with ephemeral-credential TURN as a last-resort relay. The same socket is what makes
  the machine show "online" on the dashboard — no polling, no heartbeats.

Every session goes through the same gate: pairing token → PIN challenge → only then does the
screen start. Pointer coordinates travel normalized to `[0,1]`, so control is resolution- and
Retina-independent. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design seams.

## Cloud (optional)

LAN needs nothing. Remote access and the device dashboard run on the **hosted WhipDesk.com
backend, which is baked into this repo** (`apps/desktop-agent/src/cloud/config.ts`) — so it just
works out of the box. On startup the agent asks whether to enable secure cloud discovery; answer
**No** to stay strictly LAN-only, and nothing ever leaves your network.

The cloud seam is small: Firebase Auth signs you in (passwordless email-link, same account as
the website) and the **WhipDesk edge** (a Cloudflare Worker) carries presence + the WebRTC
handshake over one authenticated WebSocket per machine. The baked-in values are a Firebase
**web** config — public by design, the same ones whipdesk.com serves in its browser bundle. They
are **not** secrets: there's no service-account key, cloud is opt-in, and every message is
locked to your own account by your verified sign-in.

**Prefer your own backend?** Point the agent at your own Firebase project + edge service by
dropping a web config (plus an `edgeUrl`) in `.whipdesk/firebase.json` (gitignored) — that file
is the only override, and it replaces the baked-in default. The full walkthrough, including the
small signaling contract your edge needs to speak, is in
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Project layout

```
packages/protocol/      Types-only wire contract shared by both apps
apps/desktop-agent/      Node host: capture, input, server, watchers, cloud
apps/mobile-web/         Vite PWA controller, served by the agent
scripts/                 notify.mjs + smoke-test harnesses
docs/ARCHITECTURE.md     Design rationale
docs/SELF_HOSTING.md     LAN-only setup + bring-your-own backend guide
docs/HOOKS.md            Optional agent-native hooks for instant monitoring alerts
```

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md). Read [AGENTS.md](AGENTS.md) first — it's the operating
contract for both humans and AI coding agents (where each change goes, the wire-contract-first
rule, how to verify). In short:

```bash
npm run typecheck    # tsc --noEmit across workspaces
npm run test         # node --test (auth handshake, pin, monitor states, crypto, protocol contract)
```

## Security

Found a vulnerability? Please open a [security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new)
rather than a public issue. Good-faith security research is welcome.

### Privacy & telemetry

WhipDesk contains **no analytics and no tracking**. The only network call the agent makes on its
own is a daily **update check** to `https://whipdesk.com/api/version` ([source](https://github.com/BinaryBananaLLC/WhipDesk/blob/main/apps/desktop-agent/src/util/update-check.ts)),
which carries exactly two things: the agent version (in the User-Agent) and the OS platform
(`darwin`/`win32`/`linux`). No user id, no machine id, no IP retention — the server keeps only
aggregate counts per version/platform/country so we know which releases are still out there.
Packaged agents only; source checkouts never phone home.

Disable it entirely with `.whipdesk/settings.json`:

```json
{ "updateCheck": false }
```

## License

[GNU AGPL-3.0](LICENSE). You're free to run, study, modify, and share WhipDesk. If you offer a
modified version as a network service, the AGPL requires you to publish your source under the
same license. For commercial licensing, contact BinaryBanana LLC.

Everything that runs on your machine is in this repo, open source; the hosted
[whipdesk.com](https://whipdesk.com) connectivity service (remote handshake, relays, device
dashboard) is what might fund its development. The WhipDesk name and logo are trademarks of
BinaryBanana LLC and aren't covered by the code license — forks need their own branding
(see [TRADEMARK.md](TRADEMARK.md)).

## Star History

<a href="https://star-history.com/#BinaryBananaLLC/WhipDesk&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
 </picture>
</a>
