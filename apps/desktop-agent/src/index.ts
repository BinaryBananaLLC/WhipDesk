import { createInterface } from "node:readline";
import { hostname, platform } from "node:os";
import { AGENT_VERSION } from "./config";
import { loadCloudConfig, loadDeviceIdentity } from "./cloud/config";
import { clearPersistedAuth, ensureAgentAuth, getPersistedAuthSummary } from "./cloud/auth";
import { createFirestoreRest } from "./cloud/firestore-rest";
import { createRtdbRest } from "./cloud/rtdb-rest";
import { startDeviceRegistry, type RegistryHandle } from "./cloud/registry";
import { startPushPublisher, type PushPublisherHandle } from "./cloud/push-publisher";
import { fetchIceServers } from "./cloud/ice";
import { startSignaling, type SignalingHandle } from "./signaling/rtdb";
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
  console.log("  Make this machine securely discoverable outside this LAN via WhipDesk.com?");
  console.log("  - You'll sign in as the SAME real user as on the website (passwordless email link).");
  console.log("  - The connection is peer-to-peer and encrypted end-to-end. If your network blocks");
  console.log("    a direct link, a secure relay server passes the traffic through for you — it stays");
  console.log("    encrypted, so the relay can never see your screen or keystrokes.");
  const answer = (await ask("  Enable secure cloud access with WhipDesk.com now? [y/N]: ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function main(): Promise<void> {
  printBanner();
  const { config, presence, keepAwake, ctx } = await startAgent();
  printConnectInfo(config.port, config.token);
  printSetupReminder();

  // Cloud is OPT-IN (LAN-only needs no account). The hosted WhipDesk.com backend is baked in
  // (cloud/config.ts), so enabling it just needs a yes at the startup prompt. Cloud powers the
  // dashboard registry AND remote WebRTC signaling (the data path stays P2P; Firebase only
  // brokers the handshake).
  //
  // Auth is the REAL user via passwordless email-link (NO anonymous auth): the agent and the
  // website sign in as the same person, so every Firestore read/write is request.auth-gated.
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
      // Presence + signaling run on RTDB (streamed pushes, $0 idle); the FCM push relay stays on
      // Firestore (rare event-driven writes that trigger the Cloud Function).
      const rtdb = createRtdbRest(cloud, auth);
      const firestore = createFirestoreRest(cloud, auth);
      registry = await startDeviceRegistry({
        rtdb,
        identity,
        name: hostname(),
        platform: platform(),
        version: AGENT_VERSION,
        getLan: () => ({ ip: getLanIp(), port: config.port, token: config.token }),
      });
      // Off-LAN ICE (STUN-first, ephemeral TURN) is minted by the cloud backend; the agent never
      // holds the relay secret — it just presents its ID token. Falls back to public STUN.
      if (registry) signaling = await startSignaling(ctx, rtdb, identity, () => fetchIceServers(cloud, auth));
      // Mirror alerts to FCM so they arrive even when the controller PWA is closed. Pass this
      // machine's id so the push can deep-link the click back to it on the dashboard.
      pushPublisher = startPushPublisher(ctx.hub, firestore, identity.deviceId);
    }
  } else {
    log.info("cloud: disabled (LAN-only) for this run.");
  }

  const shutdown = async () => {
    presence.stop();
    keepAwake.stop();
    pushPublisher?.stop();
    signaling?.stop();
    if (registry) await registry.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error("fatal", error);
  process.exit(1);
});
