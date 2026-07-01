import { log } from "../logger";
import type { RtdbRest } from "./rtdb-rest";
import type { DeviceIdentity } from "./config";

export interface LanEndpoint {
  ip: string;
  port: number;
  token: string;
}

export interface RegistryOptions {
  rtdb: RtdbRest;
  identity: DeviceIdentity;
  name: string;
  platform: string;
  version: string;
  /** Re-read at each heartbeat so a changed LAN IP is reflected. */
  getLan: () => LanEndpoint;
}

export interface RegistryHandle {
  stop: () => Promise<void>;
}

// RTDB writes/uploads are free, so we heartbeat often enough for snappy presence (the only
// cost is the dashboard's tiny download while it's open). Online = a heartbeat within ~2.5 min.
const HEARTBEAT_MS = 60_000;

/**
 * Publishes this machine to the device registry (devices/{uid}/{deviceId} in RTDB) so the
 * website can list it and offer one-tap connect — no remembering IPs. The agent is signed in
 * as the REAL user, so it writes under its own uid and the device is owned the moment it
 * registers. Fail-soft: any cloud error is logged and the agent keeps serving on the LAN.
 *
 * Presence is a lightweight heartbeat (lastSeenMs) rather than a periodic Firestore write —
 * free in RTDB — plus an explicit online:false on clean shutdown.
 */
export async function startDeviceRegistry(options: RegistryOptions): Promise<RegistryHandle | null> {
  const { rtdb, identity } = options;

  const writeDoc = async (online: boolean) => {
    const lan = options.getLan();
    // Short field names keep the RTDB record (and the dashboard's repeated reads) tiny:
    // n=name p=platform v=agentVersion o=ownerUid l={i:ip,p:port,t:token} on=online ls=lastSeenMs.
    await rtdb.putDevice(identity.deviceId, {
      n: options.name,
      p: options.platform,
      v: options.version,
      o: rtdb.uid,
      l: { i: lan.ip, p: lan.port, t: lan.token },
      on: online,
      ls: Date.now(),
    });
  };

  try {
    await writeDoc(true);
    log.info(`cloud: registered "${options.name}" to your account ✓`);
  } catch (error) {
    log.warn("cloud registry disabled:", (error as Error).message);
    return null;
  }

  let lastEndpoint = endpointKey(options.getLan());

  const timer = setInterval(() => {
    const endpoint = endpointKey(options.getLan());
    if (endpoint !== lastEndpoint) {
      // Endpoint moved (new LAN IP): rewrite the whole record so the connect URL is current.
      void writeDoc(true)
        .then(() => {
          lastEndpoint = endpoint;
          log.info(`cloud: endpoint changed -> ${endpoint}, registry updated`);
        })
        .catch((error) => log.warn("cloud heartbeat failed:", (error as Error).message));
    } else {
      void rtdb
        .patchDevice(identity.deviceId, { on: true, ls: Date.now() })
        .catch((error) => log.warn("cloud heartbeat failed:", (error as Error).message));
    }
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      try {
        await rtdb.patchDevice(identity.deviceId, { on: false, ls: Date.now() });
      } catch {
        /* best effort on shutdown */
      }
    },
  };
}

function endpointKey(lan: LanEndpoint): string {
  return `${lan.ip}:${lan.port}`;
}
