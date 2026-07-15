# Updating WhipDesk

WhipDesk does **not** auto-update itself. The agent is a program that watches your machine and
injects input, so it never silently downloads and runs new code in the background — you stay in
control of when (and whether) you upgrade. Instead, WhipDesk *tells you* when a new version is out
and you update with one command for however you installed it.

Your pairing, PIN, machine name, saved lashes, and cloud identity all live in `~/.whipdesk`
(`%USERPROFILE%\.whipdesk` on Windows), **outside** the program files — so updating never re-pairs
you or loses your settings.

## How you're notified

When a new release ships, three independent things surface it — you don't have to be watching the
terminal:

| Where | What you see | Source |
| --- | --- | --- |
| **Running agent (terminal)** | `update available: v0.1.5 (running v0.1.4) — <release URL>` on the log | `apps/desktop-agent/src/util/update-check.ts` |
| **Connected phone/controller** | A "WhipDesk update available" notification in the app — even on a **LAN-only** session (it rides the live control channel, no cloud needed) | agent `hub.emit` → controller |
| **whipdesk.com dashboard** | Each device card shows `agent 0.1.4 (update available → 0.1.5)` next to the machine that's behind | `src/lib/latestRelease.ts` + `Dashboard.tsx` |

There's also a separate **"agent out of date"** banner in the controller if the agent speaks an
older *wire protocol* than the (always-fresh) web client — that's the hard "you must update to
connect properly" signal, distinct from the routine "a newer version exists" nudge above.

### How the check works

The agent checks **at startup and every 24 h** (agents run for weeks, so a startup-only check would
miss releases). It requests `https://whipdesk.com/api/version` — a Cloudflare Worker that fronts the
GitHub Releases API with a 10-minute cache, so per-user GitHub rate limits never apply. Only
**distributed builds** check (SEA downloads and `npm i -g` installs); a monorepo source checkout run
via `tsx` does not — you update those with `git pull`.

**Privacy.** The check sends only the agent version (`User-Agent: whipdesk/x.y.z`) and the OS
platform — no user id, no machine id, and the server never stores IPs (it keeps
version/platform/country aggregates only). Turn it off entirely with `{ "updateCheck": false }` in
`~/.whipdesk/settings.json`.

## How to update

Use the command that matches **how you installed** the agent. The version you're on prints on
startup and is shown in the controller's Connection dialog.

| Installed with | Update command |
| --- | --- |
| **npm** (`npm i -g whipdesk`) | `npm install -g whipdesk@latest` |
| **Homebrew** (macOS) | `brew update && brew upgrade --cask whipdesk` |
| **Scoop** (Windows) | `scoop update whipdesk` |
| **Quick-install script** | Re-run it — it always fetches the latest signed release:<br>`curl -fsSL https://whipdesk.com/install.sh \| bash` (macOS/Linux)<br>`powershell -c "irm https://whipdesk.com/install.ps1 \| iex"` (Windows) |
| **`.pkg` / `.exe` / `.zip` / `.tar.gz` download** | Download the latest from the [releases page](https://github.com/BinaryBananaLLC/WhipDesk/releases/latest) and install over the top (the `.pkg`/`.exe` installers handle replacement; for the portable `.zip`/`.tar.gz`, overwrite the old files). |
| **Source checkout** (`npm run whipdesk` from a clone) | `git pull && npm install` |

After updating, start the agent again (`whipdesk`) — it reuses everything in `~/.whipdesk`, so your
phone reconnects with the same PIN and pairing.

> **Verify a download before running it** — see
> [VERIFYING-DOWNLOADS.md](VERIFYING-DOWNLOADS.md). Every release ships a `SHA256SUMS.txt`; the
> install one-liners verify it for you, and macOS `.pkg`s are notarized.

## Releasing (maintainers)

Tag a semver release and CI does the rest — see [RELEASING.md](RELEASING.md). Once the GitHub
release is published, `whipdesk.com/api/version` picks it up within its 10-minute cache and every
agent surfaces the update on its next check.
