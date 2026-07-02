# Security Policy

WhipDesk gives a remote browser control over a real desktop, so we take security seriously.
This page describes the security model as implemented in this repo — every claim below maps to
code you can read.

## Reporting a vulnerability

Please report privately via a [GitHub security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new)
— do not open a public issue for an unpatched flaw. We aim to acknowledge within a few days.

Good-faith security research is welcome. Acting in good faith means: don't access data that
isn't yours, don't degrade the service for others, and give us reasonable time to fix before
disclosing.

## Scope

This repo is the open-source agent + web controller. Issues in the hosted service
(whipdesk.com) can be reported the same way.

## The security model

### Two gates on every connection

Every controller connection — LAN or remote, first or hundredth — passes the same gate before it
can see a single pixel or send a single keystroke:

1. **Pairing token.** A 128-bit random token generated on first run, stored only on your machine
   (`~/.whipdesk/token`, mode `0600`) and embedded in the QR/link you scan. Compared in constant
   time (`transport/session.ts`).
2. **PIN challenge/response.** The PIN itself **never crosses the wire**. The agent stores only a
   salted, 60,000-round SHA-256-stretched key (`security/pin.ts`). On each connection it issues a
   fresh 128-bit nonce; the controller answers with `sha256(stretchedKey + ":" + nonce)`. The
   agent verifies with a constant-time compare. The nonce makes every handshake unique, so a
   captured response can't be replayed.

There is no long-lived session cookie or "remember this device": reconnecting re-runs both gates.
The controller keeps the PIN **in memory only** (never localStorage), so a page refresh always
re-prompts.

### Brute-force lockout that survives restarts

Wrong-PIN attempts are throttled per client **and** globally, with exponential backoff (60s
doubling up to 1 hour), persisted to disk (`security/throttle.ts`) — reconnecting or restarting
the agent does not reset the counter. Five failures lock a client out; a global budget stops
distributed guessing without letting an attacker lock *you* out for long.

### Not one frame before auth

The screen encoder is attached to the WebRTC connection **only after** the token + PIN gate
passes (`transport/webrtc.ts`). While the PIN dialog is up, the video track exists but carries
nothing — there is no window where frames leak to an unauthenticated peer.

### Transport encryption

Screen video and the control channel ride WebRTC with mandatory **DTLS-SRTP** — the same
protocol-enforced encryption as a video call. Connections prefer direct peer-to-peer (LAN host
route, then STUN); a TURN relay is used only as a last resort, and a relay **forwards encrypted
packets it cannot decrypt**.

Remote signaling (one SDP offer/answer + ICE candidates) is brokered per-account: both your agent
and your phone must be signed in to the *same* account, and server-side rules bar every other
account from reading or writing your signaling data. Nothing about your session is visible to
other users.

### What stays on your machine

All secrets live in the agent's state dir with owner-only permissions (`0600`): the pairing
token, the stretched PIN key (never the PIN), throttle state, and — if you opt into cloud
discovery — the account refresh token. The agent never logs PIN or token values.

Local write-endpoints (`/api/notify`, `/api/agent-event`) require the pairing token as a Bearer
header, so other devices on your network can't spoof notifications or agent events.

### LAN mode assumptions

Pure-LAN mode (no cloud) serves the controller over plain HTTP on your network, because a
non-secure origin is the only way a phone browser can reach a bare LAN IP. That means the initial
WebSocket signaling is not TLS-encrypted — the PIN scheme is designed for this (challenge/response,
nothing replayable, nothing secret on the wire), and the WebRTC media itself is still DTLS-
encrypted. Treat LAN mode as trusting your own Wi-Fi; if your network is hostile, use remote mode
or a VPN.

### What the cloud can and cannot see (opt-in)

Cloud discovery is strictly opt-in and carries: your account email, device name/platform/version,
online status, and the encrypted-connection handshake. It **cannot** see your screen, files,
keystrokes, or PIN — media is end-to-end DTLS between your phone and your desktop. You can also
point the agent at your own backend (`.whipdesk/firebase.json`) if you prefer to run everything
yourself.

## Verifying what you run

Releases are built by GitHub Actions from the tagged source with SLSA build provenance, macOS
packages are notarized, checksums are published, and the npm package carries npm provenance.
See [docs/VERIFYING-DOWNLOADS.md](docs/VERIFYING-DOWNLOADS.md).
