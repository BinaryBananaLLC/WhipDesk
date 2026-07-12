import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger";
import type { CloudConfig } from "./config";

/**
 * Real, FREE, per-user sign-in for the desktop agent — NO anonymous auth.
 *
 * The agent and the website authenticate as the SAME real user via Firebase's passwordless
 * email-link, completed entirely over the Identity Toolkit REST API (free on the Spark plan;
 * no Cloud Functions, no billing). Flow ("device login", az-login style):
 *
 *   1. Agent asks for the user's email (interactive).
 *   2. Agent calls accounts:sendOobCode (EMAIL_SIGNIN) with continueUrl =
 *      https://whipdesk.com/agent-auth  → Firebase emails a sign-in link.
 *   3. User clicks the link, lands on whipdesk.com/agent-auth, which reads the `oobCode`
 *      from the URL and shows it (or auto-fills). The user pastes the link (or code) back
 *      into the agent (or sets it via the local callback — future).
 *   4. Agent calls accounts:signInWithEmailLink(email, oobCode) → idToken + refreshToken.
 *   5. Agent persists the refreshToken in `.whipdesk/auth.json` (gitignored) and refreshes
 *      idTokens via securetoken.googleapis.com as needed.
 *
 * The persisted refresh token means the agent only signs in once. Every edge request then
 * happens as the real user (the Worker verifies the ID token and routes to that uid's own hub),
 * so the registry + signaling are gated by real identity.
 */

const TOKEN_REFRESH_SKEW_MS = 60_000;

interface PersistedAuth {
  refreshToken: string;
  uid: string;
  email: string;
}

export interface PersistedAuthSummary {
  uid: string;
  email: string;
}

export interface AgentAuth {
  uid: string;
  email: string;
  /** Returns a valid idToken, refreshing if needed. */
  getIdToken(): Promise<string>;
}

function authPath(stateDir: string): string {
  return join(stateDir, "auth.json");
}

function loadPersisted(stateDir: string): PersistedAuth | null {
  try {
    const p = authPath(stateDir);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<PersistedAuth>;
    if (parsed.refreshToken && parsed.uid) {
      return { refreshToken: parsed.refreshToken, uid: parsed.uid, email: parsed.email ?? "" };
    }
  } catch {
    /* treat as signed-out */
  }
  return null;
}

/** Small read-only view of the saved sign-in (for startup prompts). */
export function getPersistedAuthSummary(stateDir: string): PersistedAuthSummary | null {
  const persisted = loadPersisted(stateDir);
  return persisted ? { uid: persisted.uid, email: persisted.email } : null;
}

/** Forget the saved cloud sign-in so the next run can sign in as a different user. */
export function clearPersistedAuth(stateDir: string): void {
  try {
    rmSync(authPath(stateDir), { force: true });
  } catch {
    /* non-fatal */
  }
}

function persist(stateDir: string, auth: PersistedAuth): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(authPath(stateDir), JSON.stringify(auth), { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (json as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json;
}

/** Refresh an idToken from a refresh token (free securetoken endpoint). */
async function refreshIdToken(apiKey: string, refreshToken: string): Promise<{ idToken: string; expiresInMs: number; uid: string }> {
  const json = await postJson(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    idToken: json.id_token,
    expiresInMs: Number(json.expires_in ?? 3600) * 1000,
    uid: json.user_id,
  };
}

/**
 * Ensure the agent is signed in as the real user. Reuses a persisted refresh token if
 * present; otherwise runs the interactive email-link sign-in. Returns null if it can't sign
 * in (e.g. no TTY and no token) so the caller stays LAN-only.
 */
export async function ensureAgentAuth(
  config: CloudConfig,
  stateDir: string,
  ask: (q: string) => Promise<string>,
): Promise<AgentAuth | null> {
  const apiKey = config.apiKey;
  let persisted = loadPersisted(stateDir);

  // Validate / refresh an existing session.
  if (persisted) {
    try {
      const r = await refreshIdToken(apiKey, persisted.refreshToken);
      log.info(`cloud: signed in as ${persisted.email || r.uid}`);
      return makeAuth(apiKey, stateDir, persisted, r.idToken, r.expiresInMs);
    } catch (error) {
      log.warn("cloud: saved sign-in expired, re-authenticating:", (error as Error).message);
      persisted = null;
    }
  }

  // Interactive passwordless email-link sign-in.
  const email = (process.stdin.isTTY ? await ask("  Your WhipDesk email: ") : "").trim();
  if (!email) {
    log.warn("cloud: no email to sign in with — run the agent in a terminal to sign in. Staying LAN-only.");
    return null;
  }

  const continueUrl = "https://whipdesk.com/agent-auth/";
  try {
    await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
      requestType: "EMAIL_SIGNIN",
      email,
      continueUrl,
      canHandleCodeInApp: true,
    });
  } catch (error) {
    log.warn("cloud: failed to send sign-in email:", (error as Error).message);
    return null;
  }

  console.log("");
  console.log(`  We emailed a sign-in link to ${email}.`);
  console.log("  Open the sign-in link from that email on any device.");
  console.log("  Then paste EITHER the full sign-in link OR the sign-in code back here.");

  for (let attempt = 0; attempt < 3; attempt++) {
    const pasted = (await ask("  Paste the sign-in link / code: ")).trim();
    const oobCode = extractOobCode(pasted);
    if (!oobCode) {
      console.log("  Couldn't find a code in that — paste the sign-in link from the email or the code shown on the page.");
      continue;
    }
    try {
      const json = await postJson(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${apiKey}`,
        { email, oobCode },
      );
      const record: PersistedAuth = { refreshToken: json.refreshToken, uid: json.localId, email };
      persist(stateDir, record);
      const r = await refreshIdToken(apiKey, record.refreshToken);
      log.info(`cloud: signed in as ${email} ✓`);
      const auth = makeAuth(apiKey, stateDir, record, r.idToken, r.expiresInMs);
      // Best-effort: record this sign-in on the backend so the account profile exists even for
      // agent-only (headless-first) accounts. Never blocks or fails the sign-in.
      recordSignInOnEdge(config, auth);
      return auth;
    } catch (error) {
      console.log(`  Sign-in failed: ${(error as Error).message}. Try the newest email link.`);
    }
  }
  log.warn("cloud: sign-in not completed — staying LAN-only.");
  return null;
}

/** Fire-and-forget POST /v1/signin — the edge records email (from the verified token) + hashed IP. */
function recordSignInOnEdge(config: CloudConfig, auth: AgentAuth): void {
  const base = (config.edgeUrl ?? "https://edge.whipdesk.com").replace(/\/$/, "");
  void auth
    .getIdToken()
    .then((t) => fetch(`${base}/v1/signin`, { method: "POST", headers: { authorization: `Bearer ${t}` } }))
    .catch(() => {
      /* best-effort */
    });
}

function makeAuth(
  apiKey: string,
  stateDir: string,
  record: PersistedAuth,
  initialIdToken: string,
  initialExpiresMs: number,
): AgentAuth {
  let idToken = initialIdToken;
  let expiresAt = Date.now() + initialExpiresMs;
  return {
    uid: record.uid,
    email: record.email,
    async getIdToken() {
      if (Date.now() < expiresAt - TOKEN_REFRESH_SKEW_MS) return idToken;
      const r = await refreshIdToken(apiKey, record.refreshToken);
      idToken = r.idToken;
      expiresAt = Date.now() + r.expiresInMs;
      return idToken;
    },
  };
}

/** Accept a full sign-in link, a `?oobCode=...` URL, or a bare code. */
function extractOobCode(input: string): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    const code = url.searchParams.get("oobCode");
    if (code) return code;
  } catch {
    /* not a URL */
  }
  const m = input.match(/oobCode=([^&\s]+)/);
  if (m) return m[1]!;
  // A bare code looks like a longish token with no spaces.
  if (/^[A-Za-z0-9_-]{12,}$/.test(input)) return input;
  return null;
}
