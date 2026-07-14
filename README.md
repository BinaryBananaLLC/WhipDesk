<div align="center">


<h1>WhipDesk - Control AI Coding Agents From Anywhere</h1>
<h3>A secure, open-source remote access tool for vibecoders on the go.</h3>

[![CI](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BinaryBananaLLC/WhipDesk)](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest)
[![GitHub downloads](https://img.shields.io/github/downloads/BinaryBananaLLC/WhipDesk/total)](https://github.com/BinaryBananaLLC/WhipDesk/releases)
[![npm](https://img.shields.io/npm/dm/whipdesk)](https://www.npmjs.com/package/whipdesk)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/BinaryBananaLLC/WhipDesk/badge)](https://scorecard.dev/viewer/?uri=github.com/BinaryBananaLLC/WhipDesk)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

<img src="https://whipdesk.com/art-optimized/site_poster.webp" alt="WhipDesk - your AI coding agents, controlled from your phone" width="720" />

[WhipDesk.com](https://whipdesk.com) · [Install](#install) · [Features](#what-makes-whipdesk-unique) · [How it works](#how-it-works) · [FAQ](https://whipdesk.com/faq/)


</div>

WhipDesk is a **mobile-first remote access tool** designed specifically for developers who need to oversee and manage AI coding agents running on their dev machines—**directly from their phones**. 

## Why WhipDesk?

Modern AI workflows require more than traditional tools can offer:

- **Beyond the Terminal:** Terminal-only apps limit you to agent chats only. WhipDesk gives you full access to your entire desktop and development environment so you can view code changes, inspect UI fixes, and run any desktop app.
- **Built for Mobile & AI:** Traditional remote desktop tools are notoriously clunky on small screens with very limited support for reading text, and weren't built with AI agents in mind. WhipDesk is tailored for mobile-first control, letting you effortlessly monitor, guide, and course-correct your vibecoding sessions from anywhere.

**Free, open-source, and end-to-end encrypted**. WhipDesk works entirely on your local network without any account—or from anywhere in the world with a free sign-in at [WhipDesk.com](https://whipdesk.com).

## Demo

<!-- TODO(demo video): terminal `npm install -g whipdesk` → `whipdesk` (LAN, skip cloud) → phone scans the QR →
     zoom into VS Code, browse files, view a diff, type a new prompt to the AI →
     "To connect beyond your local network, sign in on WhipDesk.com and in your agent" → connecting from the park. -->
<div align="center">
<video src="https://whipdesk.com/art/demo_readme.mp4" autoplay loop muted playsinline width="750"></video>
</div>

## Quick Start

### 1. Install the agent on your dev machine

#### macOS

```bash
# npm
npm install -g whipdesk

# or Homebrew
brew install --cask BinaryBananaLLC/whipdesk/whipdesk

# or Quick install
curl -fsSL https://whipdesk.com/install.sh | bash
```

#### Windows

```powershell
# npm
npm install -g whipdesk

# or Quick install
powershell -c "irm https://whipdesk.com/install.ps1 | iex"

# or Scoop
scoop install whipdesk
```

#### Linux

```bash
# npm
npm install -g whipdesk

# or Quick install
curl -fsSL https://whipdesk.com/install.sh | bash
```

### 2. Start WhipDesk

```bash
whipdesk
```

On first run, WhipDesk will ask you to set an access PIN. Use at least 6 characters.

Depending on your OS, you may also need to grant permissions so WhipDesk can capture the screen and control input:

- **macOS:** Grant **Screen Recording** and **Accessibility** in *System Settings -> Privacy & Security* to the app that launched the agent, such as Terminal, iTerm, or VS Code. Then fully quit and reopen that app.
- **Windows:** Works out of the box. To see and control elevated windows, launch your terminal as Administrator.
- **Linux:** X11 works out of the box. On Wayland, you need `xdg-desktop-portal` plus your compositor's screen-share backend.

### 3. Connect from your phone 

#### On the same Wi-Fi / LAN
Scan the QR code printed in the terminal, open the link, enter your PIN, and connect. No account, no cloud dependency, and your data never leaves your network.

#### Connect from anywhere
To connect your devices outside of your local network, they need a way to find each other. Sign in with the same email address on [WhipDesk.com](https://whipdesk.com) and in the agent during setup. Your dev machines will immediately appear in your [dashboard](https://whipdesk.com/dashboard/), ready to connect from anywhere in the world. WhipDesk.com handles device discovery, signaling, and optional push notifications.

**You are now ready to whip lazy AI back to work!**

<div align="center">
<img src="https://whipdesk.com/art-optimized/readme1.webp" alt="WhipDesk — control AI coding agents from anywhere" width="720" />
</div>

## How it works

The WhipDesk agent runs on your dev machine similarly to a typical remote access app. It captures and shares the screen with real mouse and keyboard control, serving the web client that your phone loads.

### On your local network
Your phone and the agent connect directly over WebRTC — DTLS-encrypted, phone-to-desktop, with nothing in between. The entire logic behind this connection lives safely in this repository.

### Outside your local network
When you sign in, WhipDesk.com introduces your devices to each other; the session itself **always stays end-to-end encrypted** between them. Most connections flow directly peer-to-peer. When NAT traversals fail, traffic goes through a secure TURN relay that only forwards sealed packets it cannot read.

Either way, every connection must answer your PIN before the screen starts—and **the PIN itself never crosses the wire**. Design details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and our threat model in [SECURITY.md](SECURITY.md).



## What makes WhipDesk unique

- **Actually usable on a phone:** Built mobile-first, not desktop-first squeezed onto a phone. Landscape mode, full-screen viewing, and touch-native controls make reading code on a 4K dev box feel natural.
- **Smart zoom, crystal-clear text:** WhipDesk streams only the part of the screen you're looking at, so zoomed-in code stays razor-sharp even on weak cellular connections. Pan around, and the picture seamlessly updates while the stream catches up.
- <img src="https://whipdesk.com/art-optimized/auto-whips-icon.webp" alt="Auto-Whips icon" width="22" height="22" align="top"> **Auto-Whips:** Get pinged the moment an agent is waiting on you, finishes a task, or crashes. Automatically detects Claude Code, Codex, Gemini CLI, Aider, GitHub Copilot CLI, opencode, Cursor Agent, and Amp—with zero config.
- <img src="https://whipdesk.com/art-optimized/whipository.webp" alt="Whipository icon" width="22" height="22" align="top"> **Whipository:** Your personal prompt library. Save the instructions you type ten times a day and fire them off in a single tap. 
- **Scheduled prompts:** Queue a message like "you hit the session limit, resume" for 2:00 AM when your limit resets, and wake up the agent to finish the work while you sleep.
- <img src="https://whipdesk.com/art-optimized/lash-stash-icon.webp" alt="LashStash icon" width="22" height="22" align="top"> **LashStash:** Desktop automation reimagined. Record click-type-Enter sequences and run them on demand or on a schedule—stored encrypted, locally only on your machine.
- **Push Notifications:** Enable browser notifications to get a ping even when your browser is closed. Whether your AI agent is idle, blocked, or you just want to know when things change, the notification possibilities are limitless.

## How we use it

WhipDesk is packed with the tools we use every single day to keep our own agents productive:

- **Checking in from anywhere:** Before falling asleep, right after waking up, from the living room couch, or from the park while watching the kids. Pull out your phone, glance at the screen, and course-correct your agent if needed.
- **Navigating session limits:** If our Claude session limit resets at 2 AM, we schedule a prompt. The dev box receives it exactly when the limit resets, and by morning, there's a fresh session with the work completed.
- **Bypassing repetition:** We kept retyping the same exact instructions, so we built the Whipository. Now, commands like "make no mistakes" or "run the tests" are one tap away.
- **Automating rituals:** Click a window, focus the prompt, type, press Enter, unlock the dev box at night. That's why LashStash exists—to handle daily UI automation without manual intervention.

While WhipDesk is built mobile-first and optimized for managing AI agents, it's also incredibly useful for general remote access. Need to quickly check an order on a website where you're already signed in on your dev machine? Just connect via WhipDesk. Let us know if you find interesting new use cases, or if you're missing a feature!

## Why we built it

WhipDesk was started by one person who desperately needed a way to monitor their AI agents while away from the keyboard—during lunch, on vacation, or simply stuck at the office while the AI was not working at home. 

After sharing it with a few friends, it became clear that this specific tool solved a widespread problem. Because cloud infrastructure costs money (especially for remote network relay connections), we decided to share it with the community and run the hosted components on a donation model. 

LAN usage costs nothing, which is why this repository contains everything you need to run it yourself. To connect to devices from anywhere in the world, we need a service like WhipDesk.com. It's just better together to share the costs, which is why when you sign in on WhipDesk.com, you might see a donate button. If your AI agent helped you earn a few extra dollars this month and WhipDesk played a part in that, consider supporting the project. See our Pricing page at [WhipDesk.com/pricing](https://whipdesk.com/pricing/) for more details on why it remains free.

## Privacy and Telemetry

Sessions are end-to-end encrypted between your devices. If you sign-in with WhipDesk.com, it sees only what it absolutely needs to connect your devices: your email address, device name, platform/version, online status, and connection handshake metadata.

The agent contains **no analytics and no tracking**. Its only self-initiated network call is the update check, which sends just the running version and OS platform. You can easily turn that off in `.whipdesk/settings.json`:

```json
{ "updateCheck": false }
```

Every release is built by GitHub Actions straight from the tagged source—signed, notarized, and [verifiable](docs/VERIFYING-DOWNLOADS.md). WhipDesk alerts you when an update ships but never auto-updates (see [how to update](docs/UPDATING.md)).

Don't take our word for it—the code is right here. Read it, audit it, or point your favorite AI agent at it for a security review.

## Troubleshooting

If you see a black screen, wallpaper-only frames, or input that does not work, check your OS permissions first. On macOS, almost every capture/input failure comes from missing **Screen Recording** or **Accessibility** permissions, or from forgetting to restart the app that launched the agent after granting them.

For deeper logs, run agent with verbose parameter like:

```bash
whipdesk --verbose
```

If the problem persists, open an issue on [GitHub](https://github.com/BinaryBananaLLC/WhipDesk/issues) or post on [Reddit](https://www.reddit.com/r/WhipDesk/).

## Contributing

Contributions are highly encouraged! See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and please read [AGENTS.md](AGENTS.md) first to understand the repository's working contract.

```bash
npm install
npm run dev          # builds the web controller, then starts the agent from source
npm run typecheck
npm run test
```

LAN mode is fully self-contained in this repo, and the remote path is well-documented to inspect, review, and extend. If you want to build on top of WhipDesk or point it at your own backend, start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Reporting Security Issues

Found a vulnerability? Please open a [GitHub security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new) instead of a public issue. Good-faith security research is always welcome and appreciated.

## License

[GNU AGPL-3.0](LICENSE) - run it, study it, modify it, and share it. If you offer a modified version as a network service, the AGPL requires publishing your source under the same license. For commercial licensing, contact BinaryBanana LLC.

The WhipDesk name and logo are trademarks of BinaryBanana LLC. Forks need their own branding; see [TRADEMARK.md](TRADEMARK.md).

## Star History

<a href="https://star-history.com/#BinaryBananaLLC/WhipDesk&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
 </picture>
</a>
