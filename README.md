<div align="center">

# WhipDesk — Control AI Coding Agents from Anywhere

<!-- ###  -->

[![CI](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BinaryBananaLLC/WhipDesk)](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest)
[![GitHub downloads](https://img.shields.io/github/downloads/BinaryBananaLLC/WhipDesk/total)](https://github.com/BinaryBananaLLC/WhipDesk/releases)
[![npm](https://img.shields.io/npm/dm/whipdesk)](https://www.npmjs.com/package/whipdesk)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/BinaryBananaLLC/WhipDesk/badge)](https://scorecard.dev/viewer/?uri=github.com/BinaryBananaLLC/WhipDesk)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)






<img src="https://whipdesk.com/art-optimized/site_poster.webp" alt="WhipDesk — your AI coding agents, controlled from your phone" width="720" />





[WhipDesk.com](https://whipdesk.com) · [Install](#install) · [Features](#features) · [How it works](#how-it-works) · [FAQ](https://whipdesk.com/faq/)
</div>

<div align="center">

</div>

WhipDesk is a __mobile-first remote access tool__ designed specifically for developers who need to oversee and manage AI coding agents running on their dev machines, __directly from their phones__. 

A secure, open-source remote access tool for vibecoders on the go.

## Why WhipDesk?
Modern AI workflows require more than traditional tools can offer:

- __Beyond the Terminal:__ Terminal-only apps limit what your agents can do. WhipDesk gives you full access to your entire desktop and development environment so you never hit a wall.

- __Built for Mobile & AI:__ Traditional remote desktop tools are notoriously clunky on small screens and weren't built with AI agents in mind. WhipDesk is tailored for mobile-first control, letting you effortlessly monitor, guide, and course-correct your vibecoding sessions.


__Free, open-source, end-to-end encrypted.__ Works on your local network with no account — or from anywhere with a free sign-in at [WhipDesk.com](https://whipdesk.com).



## Demo

<!-- TODO(demo video): terminal `npm install -g whipdesk` → `whipdesk` (LAN, skip cloud) → phone scans the QR →
     zoom into VS Code, browse files, view a diff, type a new prompt to the AI →
     "To connect beyond your local network, sign in on WhipDesk.com and in your agent" → connecting from the park. -->

TODO

## Quick Start

### On developemnt machine 
Install agent on dev machine by using on of the options:
#### 🍎 macOS

```bash
# npm
npm install -g whipdesk

# Homebrew
brew install --cask BinaryBananaLLC/whipdesk/whipdesk

# Quick install
curl -fsSL https://whipdesk.com/install.sh | bash
```

#### 🪟 Windows

```powershell
# npm
npm install -g whipdesk

# Quick install
powershell -c "irm https://whipdesk.com/install.ps1 | iex"

# Scoop
scoop install whipdesk
```

#### 🐧 Linux

```bash
# npm
npm install -g whipdesk

# Quick install
curl -fsSL https://whipdesk.com/install.sh | bash
```

__and start it by calling__

```bash
whipdesk
```

You will be asked to set an access PIN to unlock dev machine. Depndingon on your OS, you might need to also __grant permissions__ to allow whipdesk to control your device remoetly:

- **macOS** — grant **Screen Recording** and **Accessibility** (System Settings → Privacy & Security) to the app that *launched* the agent — Terminal, iTerm, or VS Code — then fully quit and reopen that app.
- **Windows** — works out of the box. To see and control elevated windows (UAC prompts, apps run as administrator), launch your terminal as administrator.
- **Linux** — X11 works out of the box. Wayland needs your desktop's screen-share portal (`xdg-desktop-portal` plus your compositor's backend).

### On your phone (connected to the same Wifi)

Scan QR code from the console to intiaite connection, enter PIN and you are ready yo Whip lazy AI!

### On your phone (not connected to the same Wifi/LAN)
**To connect from outside your local network**, sign in with the same email address (no password needed) on [WhipDesk.com](https://whipdesk.com) and on your dev machine during setup — your machine will appear in your [dashboard](https://whipdesk.com/dashboard/), ready to connect from anywhere.

<div align="center">
<img src="https://whipdesk.com/art-optimized/readme1.webp" alt="WhipDesk — control AI coding agents from anywhere" width="720" />
</div>

## How it works?

The WhipDesk agent runs on your dev machine simialry to a typical remote access app. It captures and shares the screen with real mouse and keyboard control, and serves the web client your phone loads.

### On your local network

Your phone and the agent connect directly over WebRTC — DTLS-encrypted, phone-to-desktop with nothing in between. No account, no servers, nothing ever leaves your network. The entire logic behind this is in this repo.

### Outside your local network

To conenct devices outside of yoru local network, they need a way to find each other — that's where WhipDesk.com comes in. 

Sign in with the same email account on [WhipDesk.com](https://whipdesk.com) and in the agent during setup, and your dev machine shows up in your dashboard, ready to connect from the office, the park, or the beach. WhipDesk.com only introduces your devices to each other; the session itself always stays end-to-end encrypted between them — most connections flow directly peer-to-peer, and the rest go through a relay that only forwards sealed packets it can't read.

Either way, every connection has to answer your PIN before the screen starts — and the PIN itself never crosses the wire. Design details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the threat model in [SECURITY.md](SECURITY.md). 


## What makes WhipDesk unique?

- **Actually usable on a phone** — built mobile-first, not desktop-first squeezed onto a phone. Landscape mode, full-screen viewing, and touch-native controls make reading code on a 4K dev box natural.
- **Smart zoom, crystal-clear text** — WhipDesk streams only the part of the screen you're looking at, so zoomed-in code stays razor sharp even on weak cellular. Pan, and the picture blurs for a blink while the stream catches up — the trade that makes it work on low bandwidth.
- **Auto-Whips** — get pinged the moment an agent is waiting on you, finished, or crashed. Detects Claude Code, Codex, Gemini CLI, Aider, GitHub Copilot CLI, opencode, Cursor Agent, and Amp — zero config.
- **Whipository** — your personal prompt library. Save the instructions you type ten times a day and fire them in a tap. Finally you don't have to repeat "make no mistakes"!
- **Scheduled prompts** — queue "you hit the session limit, resume" for that 2am in the morning when your limit resets, and wake up the agent to finished the work, so you can sleep
- **LashStash** — desktop automation. Record click-type-Enter sequences and run them on demand or on a schedule — stored securly only on your machine. 
- **Notifications that reach you** — enable in browser notficiations to get a ping when when browser is closed. AI agient is idle, blocked or you just want to get notified whens ht change, notification tolls are limitless.

## How we use it?
WhipDesk is packed with the things we use every single day to keep our own agents in line:

- **Checking on agents from wherever we are** — before falling asleep, right after waking up, from the living-room couch, or from the garden while watching the kids. Pull out the phone, glance at the screen, whip if needed.
- **Claude session limit resets at 2 am?** We schedule a prompt — "you hit the session limit, resume" — the dev box gets it right when the limit resets, and by morning there's a fresh session with the work done.
- **We kept retyping the same prompts** — so we built the Whipository and now they're one tap away.
- **Some rituals are pure repetition** — click the window, focus the prompt, type, press Enter, even unlock the dev box at night. That's why LashStash exists: a library of desktop automations stored only on the machine.

Even though WhipDesk is built mobile firsrt and AI agents focused, we are sure it will be usefull for genereal remove access connections and otehr use cases as well. We already caught use cases like "I am signed-in on Home Depot page on dev box and I need to check the order. I will nto sign in on mobile, let me connect to dev box from WhipDesk to check it". Silly but usefull. Let us know if you ahve interesting use cases and especially if you miss a feature!


## Why we built it?

WhipDesk was started by one person who we needed a tool to monitor AI agents from anywhere (from work, while watching kids, from the park, on vacation and did I mention work? Lunch time.. when you stuck in the office and AI at home is not working?). 

After sharing it with few friends it become clear it might be usefull for more poeple. Because infrastucture cost money (especiall outside of local network connection) the idea was to share with community and run it on donations. 

LAN costs nothing so that's why this repo is all you need to run it yourselve. When you sign-in on WhipDesk.com you might however see a donate button. If your AI slop earned few $ this month and WhipDesk helped you with that, consider supporting it. See Pricing page on https://whipdesk.com/pricing/ for more details why it's all FREE.

## Privacy & telemetry

Sessions are end-to-end encrypted between your devices; even the relay only forwards sealed packets. WhipDesk.com sees just enough to introduce your devices: your email, machine name and OS, and online status. The agent contains **no analytics and no tracking**. The only self-initiated call is a daily update check ([source](apps/desktop-agent/src/util/update-check.ts)) carrying just the agent version and OS platform. You can turn it off in `.whipdesk/settings.json`:

```json
{ "updateCheck": false }
```

Every release is built by GitHub Actions straight from the tagged source — signed, notarized, and [verifiable](docs/VERIFYING-DOWNLOADS.md). WhipDesk tells you when an update ships but never auto-updates (see [how to update](docs/UPDATING.md)).

Don't take our word for it — the code is right here. Read it, or point your favorite AI agent at it for a security review.

## Troubleshooting

If you run into a black screen, wallpaper-only frames, or input that doesn't work, check the [OS permissions](#setup--permissions) first — these issues are almost always caused by that.

You can also enable verbose logs, which help understand the issue better:

```bash
whipdesk --verbose
```

If the problem persists, reach out on the [GitHub issues](https://github.com/BinaryBananaLLC/WhipDesk/issues) page, on [Reddit](https://www.reddit.com/r/WhipDesk/), or by email at [contact@whipdesk.com](mailto:contact@whipdesk.com).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Read [AGENTS.md](AGENTS.md) first: it's the operating contract for humans and AI coding agents alike.

```bash
npm install
npm run dev          # builds the web controller, then starts the agent from source
npm run typecheck
npm run test
```

### Security

Found a vulnerability? Please open a [security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new) rather than a public issue. Good-faith security research is welcome — the threat model lives in [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0](LICENSE) — run it, study it, modify it, share it. If you offer a modified version as a network service, the AGPL requires publishing your source under the same license; for commercial licensing, contact BinaryBanana LLC. Everything that runs on your machine is in this repo; the hosted [WhipDesk.com](https://whipdesk.com) connectivity service is what funds development. The WhipDesk name and logo are trademarks of BinaryBanana LLC — forks need their own branding ([TRADEMARK.md](TRADEMARK.md)).

## Star History

<a href="https://star-history.com/#BinaryBananaLLC/WhipDesk&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=BinaryBananaLLC/WhipDesk&type=Date" />
 </picture>
</a>
