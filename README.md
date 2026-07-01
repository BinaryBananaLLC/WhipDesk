# WhipDesk

> Control your desktop — and the AI coding agents running on it — from any phone browser.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

WhipDesk turns any mobile browser into a remote control for your dev machine. See the screen,
move the mouse, type, paste prompts into your AI tools, and get a push notification the moment a
long-running build or agent job finishes — no app store install, no kernel extension, no agent
running on your phone.

It's peer-to-peer: on your LAN it's a plain WebSocket; over the internet it's an encrypted
WebRTC connection that talks **directly** between phone and desktop. The cloud only brokers the
initial handshake — your screen and keystrokes never flow through anyone else's server.

## Features

- **Live screen** — full desktop or magnified, pannable region, streamed as H.264 (WebRTC) or
  JPEG (LAN).
- **Full input** — mouse, touch, and keyboard injected into the real OS; built for poking at
  AI agents and CLIs from your couch.
- **Job-done notifications** — a webhook (`POST /api/notify`) or an opt-in file watcher fires a
  notification when a slow task completes; optional background push to a closed PWA via FCM.
- **Private by design** — DTLS-encrypted P2P media, a per-session PIN gate on top, and a pairing
  token. Secrets stay on your machine.
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
([`packages/protocol`](packages/protocol)) over a swappable transport:

- **LAN** — WebSocket. Binary frames are JPEG, text frames are JSON.
- **Remote** — WebRTC: one DataChannel for control plus an H.264 video track, all DTLS-encrypted.
  Firebase Realtime Database swaps a single SDP offer/answer; STUN connects directly, with
  ephemeral-credential TURN as a fallback.

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
```

## Contributing

PRs welcome. Read [AGENTS.md](AGENTS.md) first — it's the operating contract for both humans and
AI coding agents (where each change goes, the wire-contract-first rule, how to verify). In short:

```bash
npm run typecheck    # tsc --noEmit across workspaces
npm run test         # node --test (pin, crypto, protocol contract)
```

## Security

Found a vulnerability? Please open a [security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new)
rather than a public issue. Good-faith security research is welcome.

## License

[GNU AGPL-3.0](LICENSE). You're free to run, study, modify, and share WhipDesk. If you offer a
modified version as a network service, the AGPL requires you to publish your source under the
same license. For commercial licensing, contact BinaryBanana LLC.
