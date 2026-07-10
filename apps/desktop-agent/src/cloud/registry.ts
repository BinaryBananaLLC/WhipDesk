import { log } from "../logger";
import type { EdgeClient, EdgeLan } from "./edge";

export type LanEndpoint = EdgeLan;

export interface RegistryOptions {
  edge: EdgeClient;
  /** Re-read on a timer so a changed LAN IP is reflected on the dashboard's connect link. */
  getLan: () => LanEndpoint;
}

export interface RegistryHandle {
  stop: () => void;
}

// Presence itself is connection-truth on the edge socket (no heartbeats to send). This module
// only keeps the LAN endpoint fresh: a LOCAL comparison every minute, one tiny `update` message
// on the rare tick where the IP/port actually changed.
const ENDPOINT_CHECK_MS = 60_000;

/**
 * Keeps this machine's registry entry (name/platform/version/LAN endpoint) current on the
 * user's edge hub. The initial record rides the EdgeClient's own `hello` on every (re)connect;
 * this watcher publishes endpoint changes in between. Fail-soft: if the edge is down the agent
 * keeps serving on the LAN and the next reconnect's hello carries the fresh endpoint anyway.
 */
export function startDeviceRegistry(options: RegistryOptions): RegistryHandle {
  let lastEndpoint = endpointKey(options.getLan());

  const timer = setInterval(() => {
    const lan = options.getLan();
    const endpoint = endpointKey(lan);
    if (endpoint === lastEndpoint) return;
    if (options.edge.send({ t: "update", lan })) {
      lastEndpoint = endpoint;
      log.info(`cloud: endpoint changed -> ${endpoint}, registry updated`);
    }
    // Not connected: leave lastEndpoint stale — the reconnect hello will carry the new one.
  }, ENDPOINT_CHECK_MS);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function endpointKey(lan: LanEndpoint): string {
  return `${lan.ip}:${lan.port}`;
}
