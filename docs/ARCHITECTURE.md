# Architecture

Design seams and the non-obvious "why". Wire message shapes are not here — the types in
`packages/protocol/src/index.ts` are the single source of truth. Code wins over this file.

## Transport seam (most important)

A *transport* is a bidirectional channel carrying control messages (JSON, both ways) and
screen frames (host→controller). Two impls emit identical events so nothing outside
`transport/` branches on transport type:

- **WebSocket** (`transport/websocket.ts`) — LAN. Binary `ws` frames = JPEG; text = JSON.
- **WebRTC** (`transport/webrtc.ts`) — remote. werift (pure-TS, no native build), one
  DataChannel for control + an H.264 video track for the screen; DTLS encrypts everything.
  Signaling (`signaling/edge.ts`) swaps one SDP offer/answer over the agent's WebSocket to the
  WhipDesk edge (`cloud/edge.ts` — the same always-open socket that IS the machine's "online"
  presence); the media path is then pure P2P. STUN-first, ephemeral-credential TURN as fallback
  (`cloud/ice.ts`).

Both run through one shared controller `session` (`transport/session.ts`): token gate → PIN
challenge → only then is the controller authorized and the screen starts.

## Coordinate model

Pointer x/y on the wire are normalized [0,1] of the full active display — never pixels. The
agent multiplies by the *logical* screen size (from the input backend) when injecting, so
input is resolution- and Retina/HiDPI-independent and cross-monitor control needs no client
math. The renderer derives display scale from the frame's natural size.

## Capture

`capture/screen.ts` samples the active display; `capture/displays.ts` enumerates monitors and
maps cross-monitor geometry (macOS NSScreen Cocoa→Quartz origin flip). Two output paths:

- **LAN / JPEG**: single-frame sampler — `screenshot-desktop` on macOS/Linux, the bundled ffmpeg
  (ddagrab/gdigrab, `capture/win-capture.ts`) on Windows so the Windows build ships no
  `screenshot-desktop` (its csc-compiled win32 helper trips AV/winget validation scans). Optional
  `sharp` downsizes + re-encodes and, on zoom, crops to just the visible region (`set-viewport`)
  to save bandwidth. Windows monitors enumerate natively via `capture/displays-win.ts`.
- **Remote / H.264**: `capture/encoder.ts` (ffmpeg/VideoToolbox → werift track) with a JPEG
  fallback when no usable H.264 encoder exists. A low-res "overview" track feeds the minimap
  when zoomed. The encoder applies the zoom crop as a filter.

The loop is self-pacing, skips unchanged frames, and pauses when no controller is visible.

## Input

`input/index.ts` picks a backend at startup: `NutInputBackend` (`@nut-tree-fork/nut-js`, full
mouse+keyboard) or `AppleScriptInputBackend` (keyboard-only `osascript` fallback so "send a
prompt" still works if native input fails to load). Both take normalized coords + cached
logical size.

## Session monitor (Auto-Whips)

`monitor/` is the zero-config engine behind Auto-Whips: it observes agent processes and their
transcripts to infer whether Claude Code, Codex, Aider, etc. are *working* or *stopped*, so users
never change how they launch an agent. The inference is deliberately debounced — a working agent
goes quiet mid-turn all the time — which costs up to ~30 s of latency on the "stopped" edge. Agents
that support native hooks can collapse that to zero by POSTing `/api/agent-event`
(`monitor.recordAgentEvent`); see [HOOKS.md](HOOKS.md). Hooks *refine* the monitor, they don't
replace it: an event with no live monitored session is a 404.

`lash-store.ts` (recorded LashStash click/type sequences) and `timer-store.ts` (scheduled prompts)
persist host-side under `.whipdesk/` and execute through the same input backend.

## Notifications

`NotificationHub` fans events to every connected controller (+ a small recent-event buffer).
Sources: the session monitor above, the `POST /api/notify` webhook (the generic/AI-completion
path), and an opt-in file-pattern watcher. Background push to a *closed* PWA is opt-in web push: `cloud/push-publisher.ts` relays
alerts over the agent's cloud connection, and the backend delivers them as encrypted Web Push to
the subscriptions registered by `mobile-web/src/push.ts`.

## Cloud (opt-in, OFF by default)

LAN works with no account. Answering **yes** to the startup prompt enables the device registry
(machines appear in the web dashboard) and WebRTC signaling. Auth is always the real user via
passwordless email-link — never anonymous auth. Agent and web sign in as the same person, and
every backend request is authenticated and scoped to that one account. The PIN is an app-layer
gate on top of DTLS. The client side of the whole cloud contract lives in this repo; see
[SELF_HOSTING.md](SELF_HOSTING.md) to point the agent at your own backend.

## Host requirements

macOS needs **Screen Recording** (else frames show only wallpaper) and **Accessibility** (for
input injection) granted to the launching terminal app; restart it after granting. Secrets
(pairing token, stretched PIN) persist in `.whipdesk/` (gitignored).

## Why these choices

WebSocket first = zero native pain, bulletproof on LAN. WebRTC for remote = encrypted,
serverless data path; only the handshake touches the cloud. Vanilla-TS PWA = smallest surface,
Tauri-wrappable later without a rewrite.
