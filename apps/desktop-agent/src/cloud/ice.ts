import { log } from "../logger";
import type { CloudConfig } from "./config";
import type { AgentAuth } from "./auth";
import type { EdgeClient } from "./edge";

/** An ICE server entry (STUN, or TURN with ephemeral credentials). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Our own STUN as the only fallback (no reliance on public/free STUN that can disappear). The
// edge normally returns the full STUN+TURN list; this is used solely if that fetch fails.
const FALLBACK_STUN: IceServer[] = [{ urls: "stun:turn-us1.whipdesk.com:3478" }];

interface CachedIce {
  servers: IceServer[];
  expiresMs: number;
}
let cache: CachedIce | null = null;

function remember(servers: IceServer[], ttlSec: number): IceServer[] {
  const ttl = Math.max(60, ttlSec || 600);
  cache = { servers, expiresMs: Date.now() + ttl * 1000 - 30_000 };
  return servers;
}

/**
 * Fetch STUN-first + ephemeral TURN ICE servers from the edge, cached until the creds near
 * expiry. Preferred path is IN-BAND on the already-open hub WebSocket (no extra round trip, no
 * separate auth); the HTTPS endpoint is the fallback when the socket is down. The coturn secret
 * lives ONLY on the edge — the agent presents its Firebase ID token and gets a ready-made pair.
 * Falls back to our own STUN so an edge hiccup never blocks a direct or LAN connection.
 */
export async function fetchIceServers(
  config: CloudConfig,
  auth: AgentAuth,
  edge?: EdgeClient,
): Promise<IceServer[]> {
  if (cache && cache.expiresMs > Date.now()) return cache.servers;

  if (edge?.isConnected()) {
    const result = await edge.requestIce();
    if (result) return remember(result.iceServers, result.ttlSec);
  }

  try {
    const base = (config.edgeUrl ?? "https://edge.whipdesk.com").replace(/\/$/, "");
    const token = await auth.getIdToken();
    const res = await fetch(`${base}/v1/ice`, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = (await res.json()) as { iceServers?: IceServer[]; ttlSec?: number };
      if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
        return remember(body.iceServers, Number(body.ttlSec) || 600);
      }
    } else {
      log.warn(`cloud: iceServers HTTP ${res.status} — using fallback STUN`);
    }
  } catch (error) {
    log.warn("cloud: iceServers fetch failed — using fallback STUN:", (error as Error).message);
  }
  return FALLBACK_STUN;
}
