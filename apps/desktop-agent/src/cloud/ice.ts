import { log } from "../logger";
import type { CloudConfig } from "./config";
import type { AgentAuth } from "./auth";

/** An ICE server entry (STUN, or TURN with ephemeral credentials). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Our own STUN as the only fallback (no reliance on public/free STUN that can disappear). The
// backend normally returns the full STUN+TURN list; this is used solely if that fetch fails.
const FALLBACK_STUN: IceServer[] = [{ urls: "stun:turn-us1.whipdesk.com:3478" }];

/**
 * Where the cloud backend mints ephemeral TURN credentials. The coturn secret lives ONLY in the
 * (internal) backend — the open-source agent never holds it; it just presents its Firebase ID
 * token. Defaults to the standard Cloud Functions URL derived from the project id; override with
 * an `iceUrl` field in the firebase config if the function lives elsewhere.
 */
function iceEndpoint(config: CloudConfig): string {
  const explicit = (config as { iceUrl?: string }).iceUrl;
  if (explicit) return explicit;
  return `https://us-central1-${config.projectId}.cloudfunctions.net/iceServers`;
}

interface CachedIce {
  servers: IceServer[];
  expiresMs: number;
}
let cache: CachedIce | null = null;

/**
 * Fetch STUN-first + ephemeral TURN ICE servers from the backend (authenticated). Cached until
 * the creds near expiry. Falls back to our own STUN so a backend hiccup never blocks a direct or
 * LAN connection.
 */
export async function fetchIceServers(config: CloudConfig, auth: AgentAuth): Promise<IceServer[]> {
  if (cache && cache.expiresMs > Date.now()) return cache.servers;
  try {
    const token = await auth.getIdToken();
    const res = await fetch(iceEndpoint(config), { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = (await res.json()) as { iceServers?: IceServer[]; ttlSec?: number };
      if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
        const ttl = Math.max(60, Number(body.ttlSec) || 600);
        cache = { servers: body.iceServers, expiresMs: Date.now() + ttl * 1000 - 30_000 };
        return cache.servers;
      }
    } else {
      log.warn(`cloud: iceServers HTTP ${res.status} — using fallback STUN`);
    }
  } catch (error) {
    log.warn("cloud: iceServers fetch failed — using fallback STUN:", (error as Error).message);
  }
  return FALLBACK_STUN;
}
