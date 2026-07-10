# Self-hosting WhipDesk

Short version: **LAN mode is 100% self-contained today** — no cloud, no account, nothing leaves
your network. For remote access you can use the hosted whipdesk.com backend (free, opt-in), or
bring your own backend via a single local config file.

## LAN only — nothing to host

Run the agent, scan the QR/URL, pair, done. The controller PWA is served by the agent itself
over your local network, media is pure P2P, and every session is gated by the pairing token +
PIN (see [../SECURITY.md](../SECURITY.md)). If you answer **No** to the cloud prompt at startup,
this is the whole product — zero external dependencies.

## Remote via the hosted backend (default)

Answering **Yes** to the opt-in prompt uses the hosted whipdesk.com backend: Firebase Auth for
sign-in and the WhipDesk edge for presence + the WebRTC handshake. Media stays end-to-end
encrypted P2P; the backend only carries the handshake, and falls back to an encrypted TURN relay
when a direct path is impossible. This is free; relays cost us real money, so there's a donate
button — and heavy relay usage may become a paid add-on some day. LAN mode and direct P2P will
stay free forever.

We don't publish our production edge deployment or relay fleet configuration (uptime and
abuse-prevention posture for infrastructure that serves everyone). Everything you need to run
your **own** backend is in the open, though — read on.

## Bring your own backend

The agent's only override surface is `.whipdesk/firebase.json` (gitignored, next to the agent's
state). Drop in your own Firebase **web** config and your own edge URL and the agent never talks
to whipdesk.com:

```json
{
  "apiKey": "…your Firebase web apiKey…",
  "projectId": "your-project",
  "appId": "1:…:web:…",
  "edgeUrl": "https://edge.example.com"
}
```

(`authDomain` defaults to `<projectId>.firebaseapp.com`. There are deliberately no env vars and
no CLI flags — this file is the whole override story. Resolution:
[`apps/desktop-agent/src/cloud/config.ts`](../apps/desktop-agent/src/cloud/config.ts).)

Your backend needs two things:

1. **A Firebase project** (free tier is plenty) with passwordless email-link Auth enabled —
   that's what mints the ID tokens the agent and controller present.
2. **An edge service** that verifies those ID tokens and speaks the small signaling contract
   below. Ours runs on Cloudflare Workers + Durable Objects; Firebase Realtime Database is an
   equally good fit (WhipDesk originally ran on it). Honestly, the fastest path is to hand the
   contract below plus the client sources to an AI coding assistant and ask it to scaffold the
   backend on whatever stack you already operate — it's an afternoon of code, and the AI can
   tailor it to your infra better than a fixed recipe would.

### The signaling contract (client side is all in this repo)

The complete client behavior lives in
[`apps/desktop-agent/src/cloud/`](../apps/desktop-agent/src/cloud/) (agent) and
[`apps/mobile-web/src/remote.ts`](../apps/mobile-web/src/remote.ts) (controller). What they
expect from `edgeUrl`:

- `GET /v1/connect?role=agent|client[&device=<id>]` — WebSocket upgrade. Browsers can't set
  headers on an upgrade, so the Firebase ID token rides the subprotocol list:
  `Sec-WebSocket-Protocol: whipdesk.v1, auth.<idToken>`; the server must verify the token and
  echo **only** `whipdesk.v1` back.
- Over that socket, JSON frames with `{"v":1,"t":…}`: agents send `hello` (device metadata) and
  answer with `answer`/`cand`/`end`; controllers send `connect` (SDP offer)/`cand`/`end` and
  receive `devices`/`device`/`removed` presence snapshots. The server's job is presence
  bookkeeping plus relaying those frames between one user's own sockets — nothing is persisted.
- `{"t":"ice"}` frames (or `GET /v1/ice` with a Bearer token) return
  `{ iceServers: […], ttlSec }` — your STUN/TURN list. For TURN, run
  [coturn](https://github.com/coturn/coturn) with `use-auth-secret` and mint ephemeral
  credentials: username `<expiry>:<uid>`, credential `base64(HMAC-SHA1(secret, username))`.

Media never touches the backend either way — it's WebRTC P2P with DTLS, and the PIN gate runs
inside the encrypted channel between your controller and your agent.
