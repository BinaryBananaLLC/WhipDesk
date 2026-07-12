import type { FirebaseWebConfig } from "./remote";

/**
 * Authenticated JSON calls to the WhipDesk edge (Cloudflare Worker) — the single place the
 * controller talks to for persistent user data: connection stats, whipository sync, and web-push
 * subscriptions. Auth is the signed-in user's Firebase ID token as a Bearer header.
 *
 * Token cache: every fresh token minted here (or cached explicitly by the transport) is kept as a
 * plain string so the session-end stats flush can build its request FULLY SYNCHRONOUSLY inside
 * `pagehide` — an async token mint never completes during unload. Firebase tokens live ~1 h and
 * the signaling path refreshes them continuously, so staleness is rare; an expired cached token
 * just means one undercounted session (accepted, same as before).
 */

const DEFAULT_EDGE_URL = "https://edge.whipdesk.com";

let lastToken = "";

export function edgeBase(config: FirebaseWebConfig): string {
  return (config.edgeUrl ?? DEFAULT_EDGE_URL).replace(/\/$/, "");
}

/** Remember the most recent ID token (the transport calls this on every mint it does anyway). */
export function cacheToken(token: string): void {
  if (token) lastToken = token;
}

/** Authed JSON request; mints a fresh token via `user` and caches it for the sync flush path. */
export async function edgeFetch<T>(
  config: FirebaseWebConfig,
  user: { getIdToken(): Promise<string> },
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await user.getIdToken();
  cacheToken(token);
  const res = await fetch(`${edgeBase(config)}${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fire-and-forget POST built synchronously from the cached token — `keepalive: true` lets the
 * browser finish it after the page is gone (the one thing sendBeacon can do that fetch normally
 * can't, except sendBeacon can't carry an Authorization header). No-op without a cached token.
 */
export function edgePostKeepalive(config: FirebaseWebConfig, path: string, body: unknown): void {
  if (!lastToken) return;
  try {
    void fetch(`${edgeBase(config)}${path}`, {
      method: "POST",
      keepalive: true,
      headers: { authorization: `Bearer ${lastToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {
      /* best-effort */
    });
  } catch {
    /* best-effort */
  }
}
