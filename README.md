# WhipDesk

> Control your desktop — and the AI coding agents running on it — from any phone browser.

[![CI](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BinaryBananaLLC/WhipDesk)](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest)
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
ships two ways to run the agent — both built by GitHub Actions straight from the tagged source,
with [verifiable build provenance](docs/VERIFYING-DOWNLOADS.md):

**Homebrew (macOS).**

```bash
brew install --cask BinaryBananaLLC/whipdesk/whipdesk
whipdesk
```

**Self-contained download (no Node needed).** Grab the package for your OS:

| OS | Asset | Notes |
| --- | --- | --- |
| macOS | `whipdesk-<ver>-macos-arm64.pkg` / `-x64.pkg` | Signed with a Developer ID & **notarized** — installs `whipdesk` to your PATH. |
| Windows | `whipdesk-<ver>-windows-x64.zip` | Unzip and run `whipdesk.exe`. SmartScreen: **More info → Run anyway** (see verification below). |
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

## How it works

A **desktop agent** (Node) captures the screen, injects input, and serves the **web controller**
(a framework-light vanilla-TS PWA). They speak one message contract
([`packages/protocol`](packages/protocol)) over WebRTC — one DataChannel for control plus H.264
video tracks, all DTLS-encrypted — with two ways to broker the handshake:

- **LAN** — the agent's own WebSocket swaps the SDP offer/answer; the media flows host-to-host
  on your network, touching nothing else.
- **Remote** — Firebase Realtime Database swaps the SDP; STUN connects directly, with
  ephemeral-credential TURN as a last-resort relay.

Every session goes through the same gate: pairing token → PIN challenge → only then does the
screen start. Pointer coordinates travel normalized to `[0,1]`, so control is resolution- and
Retina-independent. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design seams.

## Cloud (optional)

LAN needs nothing. Remote access and the device dashboard run on the **hosted WhipDesk.com
backend, which is baked into this repo** (`apps/desktop-agent/src/cloud/config.ts`) — so it just
works out of the box. On startup the agent asks whether to enable secure cloud discovery; answer
**No** to stay strictly LAN-only, and nothing ever touches Firebase.

Those baked-in values are a Firebase **web** config — public by design, the same ones whipdesk.com
serves in its browser bundle. They are **not** secrets: there's no service-account key, cloud is
opt-in, and every read/write is locked to your own account by the Firestore/RTDB rules. The agent
signs in as the real user via passwordless email-link — the same account as the website.

**Prefer your own backend?** Point the agent at your own Firebase project + TURN by dropping a web
config in `.whipdesk/firebase.json` (gitignored) — that file is the only override, and it
replaces the baked-in default.

## Project layout

```
packages/protocol/      Types-only wire contract shared by both apps
apps/desktop-agent/      Node host: capture, input, server, watchers, cloud
apps/mobile-web/         Vite PWA controller, served by the agent
scripts/                 notify.mjs + smoke-test harnesses
docs/ARCHITECTURE.md     Design rationale
docs/HOOKS.md            Optional agent-native hooks for instant monitoring alerts
```

## Contributing

PRs welcome. Read [AGENTS.md](AGENTS.md) first — it's the operating contract for both humans and
AI coding agents (where each change goes, the wire-contract-first rule, how to verify). In short:

```bash
npm run typecheck    # tsc --noEmit across workspaces
npm run test         # node --test (auth handshake, pin, monitor states, crypto, protocol contract)
```

## Security

Found a vulnerability? Please open a [security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new)
rather than a public issue. Good-faith security research is welcome.

## License

[GNU AGPL-3.0](LICENSE). You're free to run, study, modify, and share WhipDesk. If you offer a
modified version as a network service, the AGPL requires you to publish your source under the
same license. For commercial licensing, contact BinaryBanana LLC.
