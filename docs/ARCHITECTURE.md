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
  Signaling (`signaling/rtdb.ts`) uses Firebase only to swap one SDP offer/answer; the media
  path is then pure P2P. STUN-first, ephemeral-credential TURN as fallback (`cloud/ice.ts`).

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

## Notifications

`NotificationHub` fans events to every connected controller (+ a small recent-event buffer).
Sources: `POST /api/notify` webhook (the AI-completion path) and an opt-in file-pattern
watcher. Background push to a *closed* PWA is opt-in via FCM (`cloud/push-publisher.ts` →
`mobile-web/src/push.ts`); the Cloud Function + rules live in the separate web project.

## Cloud (opt-in, OFF by default)

LAN works with no account. Answering **yes** to the startup prompt enables the device registry
(machines appear in the web dashboard) and WebRTC signaling. Auth is the REAL user via
passwordless email-link (NO anonymous auth) — agent and web sign in as the same person, so
every Firestore access is `request.auth`-gated. The PIN is an app-layer gate on top of DTLS.

## Host requirements

macOS needs **Screen Recording** (else frames show only wallpaper) and **Accessibility** (for
input injection) granted to the launching terminal app; restart it after granting. Secrets
(pairing token, stretched PIN) persist in `.whipdesk/` (gitignored).

## Why these choices

WebSocket first = zero native pain, bulletproof on LAN. WebRTC for remote = encrypted,
serverless data path; only the handshake touches the cloud. Vanilla-TS PWA = smallest surface,
Tauri-wrappable later without a rewrite.
