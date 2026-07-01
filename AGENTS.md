# AGENTS.md — how to work in WhipDesk

The contract for *how* to change this repo. `README.md` is *what* it is. Keep both current
when structure changes.

## Hard rules

- **Never touch git state.** Read-only git (`status`/`diff`/`log`) only. No add/commit/
  checkout/reset/restore/branch/push/pull/merge/rebase/stash. The user reviews and commits
  everything; leave changes as uncommitted working-tree edits.
- **Never update production.** No deploy/publish (`deploy:zip`, `firebase deploy`, FTP, …)
  unless the user gives a one-off explicit instruction for that exact deploy.

# STRICT TOKEN & CONTEXT LIMITS
1. **Zero Chatter:** NO conversational filler, greetings, or acknowledgments (e.g., "Sure", "I can help", "Here is the code").
2. **Code Only:** Output ONLY the requested code, terminal commands, or exact file diffs. 
3. **No Explanations:** NEVER explain how the code works, why you wrote it, or your thought process unless explicitly asked. Summarize the work at the end.
4. **Context Frugality:** Read only the strictly necessary files. Do not summarize files or repeat existing code back to me unprompted. 
5. **Maximum Efficiency:** Output the absolute minimum number of tokens required to complete the immediate task.

## Mental model

WhipDesk = **host** (`apps/desktop-agent`, Node) + **controller** (`apps/mobile-web`, PWA)
talking over a **swappable transport** with a **shared message contract**
(`packages/protocol`). Transports: WebSocket on LAN, WebRTC P2P (DTLS, werift) for remote.
Treat the transport as an interface, never branch on its type outside `transport/`.

## Golden rules

1. **Edit the contract first.** Wire-crossing behavior starts as a type in
   `packages/protocol/src/index.ts` (the wire source of truth), then host, then web.
2. **`packages/protocol` is runtime-free.** Types and `const` only; both apps `import type`.
3. **Normalized coordinates.** Pointer x/y on the wire are [0,1]; convert to pixels only in
   `apps/desktop-agent/src/input/*`.
4. **Fail soft on the host.** Capture/input errors emit an `error` control message and keep
   the loop alive — never crash the process.
5. **Never log or commit secrets.** The pairing token + PIN live in `.whipdesk/` (gitignored).
6. **Keep deps light.** N-API or pure-JS only (dev box: Node 26 arm64). Capture works with
   just `screencapture`; `sharp` and `werift` are optional.
7. **Mobile client stays framework-light** (vanilla TS + Vite) so Tauri can wrap it later.

## Where to make a given change

| Goal | Touch these files |
| --- | --- |
| New wire message | `packages/protocol/src/index.ts` |
| Screen capture | `apps/desktop-agent/src/capture/*` |
| Input injection (mouse/keyboard) | `apps/desktop-agent/src/input/*` |
| Notification source (watcher) | `apps/desktop-agent/src/watchers/*` |
| Cloud device registry / auth | `apps/desktop-agent/src/cloud/*` |
| WebSocket server | `apps/desktop-agent/src/transport/websocket.ts` |
| WebRTC P2P | `apps/desktop-agent/src/transport/webrtc.ts`, `.../signaling/rtdb.ts`, `apps/mobile-web/src/remote.ts` |
| Shared controller session (both transports) | `apps/desktop-agent/src/transport/session.ts` |
| Mobile rendering / view modes | `apps/mobile-web/src/screen.ts` |
| Mobile gestures / input | `apps/mobile-web/src/input.ts` |
| Mobile UI / ribbon / prompt box | `apps/mobile-web/src/controls.ts` |

## Build / run / verify

```bash
npm install
npm run dev          # builds mobile-web, then starts the host (serves dist + WS at /ws)
npm run typecheck    # tsc --noEmit across workspaces
npm run test         # node --test (pin, crypto, protocol contract)
```

Smoke test without a phone: open the printed `http://<ip>:8787/#t=<token>` URL in a desktop
browser on the same machine. The screen should stream; clicking moves the real cursor (after
granting macOS Screen Recording + Accessibility — see `docs/ARCHITECTURE.md`).

## Style

- TypeScript, ESM, strict, 2-space indent. Small named modules, one responsibility each.
- Comment the *why*, not the *what*. Mark non-obvious seams with `// AI-AGENT:`.
- No new runtime dependency without a strong reason (prefer optional or pure-JS deps).

## When you finish

1. `npm run typecheck` clean.
2. Wire change → update the `packages/protocol` types (the wire source of truth).
3. Run/connect change → update `README.md`.
