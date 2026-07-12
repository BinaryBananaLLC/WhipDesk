import { createInterface } from "node:readline";
import { platform } from "node:os";
import { AGENT_VERSION } from "./config";
import { loadCloudConfig, loadDeviceIdentity } from "./cloud/config";
import { clearPersistedAuth, ensureAgentAuth, getPersistedAuthSummary } from "./cloud/auth";
import { EdgeClient } from "./cloud/edge";
import { startDeviceRegistry, type RegistryHandle } from "./cloud/registry";
import { startPushPublisher, type PushPublisherHandle } from "./cloud/push-publisher";
import { fetchIceServers } from "./cloud/ice";
import { startSignaling, type SignalingHandle } from "./signaling/edge";
import { log } from "./logger";
import { getLanIp, printBanner, printConnectInfo, printSetupReminder } from "./net";
import { startAgent } from "./server";

/** Prompt helper for interactive cloud sign-in (visible echo; not a secret). */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

/**
 * Ask every run whether the machine should be securely discoverable outside this LAN. Cloud uses
 * the baked-in hosted WhipDesk.com backend, so this just needs a yes/no (defaults to No).
 * Non-interactive runs (no terminal) stay LAN-only.
 */
async function resolveCloudOptIn(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  console.log("");
  console.log("  To make this machine securely reachable from outside this network, sign in below and at WhipDesk.com with the same email (quick passwordless sign-in). Skip to stay local-only.");
  const answer = (await ask("  Connect to this machine from outside your local network? [y/N]: ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function main(): Promise<void> {
  printBanner();
  const { config, presence, keepAwake, ctx } = await startAgent();
  printConnectInfo(config.port, config.token);
  printSetupReminder();

  // Cloud is OPT-IN (LAN-only needs no account). The hosted WhipDesk.com backend is baked in
  // (cloud/config.ts), so enabling it just needs a yes at the startup prompt. Cloud powers the
  // dashboard registry AND remote WebRTC signaling (the data path stays P2P; the edge only
  // brokers the handshake).
  //
  // Auth is the REAL user via passwordless email-link (NO anonymous auth): the agent and the
  // website sign in as the same person, so every edge request is verified-token-gated.
  let edge: EdgeClient | null = null;
  let registry: RegistryHandle | null = null;
  let signaling: SignalingHandle | null = null;
  let pushPublisher: PushPublisherHandle | null = null;
  const cloudEnabled = await resolveCloudOptIn();
  const cloud = cloudEnabled ? loadCloudConfig(config.stateDir) : null;
  if (cloud) {
    const identity = loadDeviceIdentity(config.stateDir);
    const savedAuth = getPersistedAuthSummary(config.stateDir);
    if (savedAuth && process.stdin.isTTY) {
      const reuse = (await ask(`  Reuse existing signed-in email ${savedAuth.email || savedAuth.uid}? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (reuse === "n" || reuse === "no") {
        clearPersistedAuth(config.stateDir);
      }
    }
    const auth = await ensureAgentAuth(cloud, config.stateDir, ask);
    if (auth) {
      // Presence + signaling + the alert relay ride ONE WebSocket to the WhipDesk edge
      // (Cloudflare) — online is simply "this socket is up", offers arrive as messages, and
      // alerts go out as `notify` frames the hub fans out as web push.
      const getLan = () => ({ ip: getLanIp(), port: config.port, token: config.token });
      edge = new EdgeClient({
        url: cloud.edgeUrl ?? "https://edge.whipdesk.com",
        auth,
        device: () => ({
          id: identity.deviceId,
          // User-chosen display name when set (persisted in the state dir), else the hostname.
          name: ctx.getMachineName(),
          platform: platform(),
          version: AGENT_VERSION,
          lan: getLan(),
        }),
      });
      // A rename from a controller re-announces immediately, so the dashboard card updates live
      // instead of waiting for the next edge reconnect.
      const edgeClient = edge;
      ctx.onMachineNameChanged = () => edgeClient.announce();
      // Off-LAN ICE (STUN-first, ephemeral TURN) is minted by the edge; the agent never holds
      // the relay secret — it just presents its ID token. Falls back to our own STUN.
      signaling = startSignaling(ctx, edge, () => fetchIceServers(cloud, auth, edge ?? undefined));
      registry = startDeviceRegistry({ edge, getLan });
      edge.start();
      // Mirror alerts over the hub socket so they arrive as web push even when the controller
      // PWA is closed. Pass this machine's id so the push can deep-link the click back to it.
      pushPublisher = startPushPublisher(ctx.hub, edge, identity.deviceId);
    }
  } else {
    log.info("cloud: disabled (LAN-only) for this run.");
  }

  const shutdown = async () => {
    presence.stop();
    keepAwake.stop();
    pushPublisher?.stop();
    signaling?.stop();
    registry?.stop();
    edge?.stop(); // clean close -> the hub flips the dashboard card to offline immediately
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error("fatal", error);
  process.exit(1);
});
