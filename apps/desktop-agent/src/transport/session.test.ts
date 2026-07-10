import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ServerMessage } from "@whipdesk/protocol";
import { PinGuard, responseFor, stretch } from "../security/pin";
import { PinThrottle } from "../security/throttle";
import type { AgentContext, Controller } from "../server";
import { createControllerSession, type RawChannel } from "./session";

/**
 * Integration test of the controller handshake — the security-critical path:
 * token gate → PIN challenge/response → welcome, with the per-connection countdown and the
 * persistent cross-reconnect throttle. Uses the REAL PinGuard + PinThrottle on a temp state
 * dir and a stubbed AgentContext, so the exact wire exchange is exercised end-to-end.
 */

const TOKEN = "test-pairing-token";
const PIN = "hunter2secret";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "whipdesk-session-test-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  ctx: AgentContext;
  typed: string[];
  authenticatedCount: number;
}

function makeCtx(stateDir: string, withPin: boolean): Harness {
  const pin = PinGuard.load(stateDir);
  if (withPin && !pin.isSet) pin.setPin(PIN);
  const typed: string[] = [];
  const harness: Harness = { typed, authenticatedCount: 0, ctx: null as unknown as AgentContext };
  const noop = () => {};
  const ctx = {
    config: { port: 0, token: TOKEN, fps: 10, quality: 75, maxWidth: 2048, watchRegex: "", stateDir, keepAwake: false },
    capturer: { backend: "test", canCrop: false, setOptions: noop },
    input: {
      name: "test",
      canMouse: true,
      canKeyboard: true,
      typeText: async (text: string) => {
        typed.push(text);
      },
      getScreenSize: async () => ({ width: 100, height: 100 }),
    },
    hub: { getRecent: () => [] },
    pin,
    pinThrottle: new PinThrottle(stateDir),
    regionWatcher: { list: () => [] },
    screen: { width: 100, height: 100 },
    displays: [],
    activeDisplay: 0,
    videoAvailable: false,
    video: null,
    hdrActive: false,
    controllers: new Set<Controller>(),
    addController: (c: Controller) => void (ctx as { controllers: Set<Controller> }).controllers.add(c),
    removeController: (c: Controller) => void (ctx as { controllers: Set<Controller> }).controllers.delete(c),
    setVisibility: noop,
    setFps: noop,
    selectDisplay: noop,
    requestFrame: noop,
    getViewport: () => ({ x: 0, y: 0, w: 1, h: 1 }),
    setViewport: noop,
    addWatchRegion: noop,
    removeWatchRegion: noop,
    addTimer: noop,
    removeTimer: noop,
    listTimers: () => [],
    saveLash: noop,
    removeLash: noop,
    listLashes: () => [],
    scanMonitors: async () => {},
    addMonitor: noop,
    removeMonitor: noop,
    listMonitors: () => [],
    setAlwaysAgent: noop,
    listAlwaysAgents: () => [],
    reportVideoStats: noop,
    getMachineName: () => "test-machine",
    setMachineName: noop,
  } as unknown as AgentContext;
  harness.ctx = ctx;
  return harness;
}

/** A fake transport channel that records everything the agent sends. */
class FakeChannel implements RawChannel {
  readonly sent: ServerMessage[] = [];
  closedWith: string | null = null;
  sendText(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(reason?: string): void {
    this.closedWith = reason ?? "";
  }
  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
  ofType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.sent.find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

const hello = (token: string) => JSON.stringify({ type: "hello", protocol: 1, token, role: "controller" });

function answerChallenge(channel: FakeChannel, pin: string): string {
  const challenge = channel.ofType("auth-required");
  assert.ok(challenge, "expected an auth-required challenge");
  const key = stretch(pin, challenge.salt, challenge.iterations);
  return JSON.stringify({ type: "auth", response: responseFor(key, challenge.nonce) });
}

test("a wrong pairing token is rejected and the channel closed", () => {
  const { ctx } = makeCtx(tempStateDir(), true);
  const channel = new FakeChannel();
  const session = createControllerSession(ctx, channel, { clientId: "attacker" });
  session.handleText(hello("wrong-token"));
  assert.equal(channel.closedWith, "invalid token");
  const err = channel.ofType("error");
  assert.equal(err?.code, "auth");
  assert.equal(channel.ofType("auth-required"), undefined, "no PIN challenge for a bad token");
});

test("valid token with no PIN configured admits immediately", () => {
  const harness = makeCtx(tempStateDir(), false);
  const channel = new FakeChannel();
  const session = createControllerSession(harness.ctx, channel, {
    clientId: "c1",
    onAuthenticated: () => harness.authenticatedCount++,
  });
  session.handleText(hello(TOKEN));
  assert.ok(channel.ofType("welcome"), "expected welcome");
  assert.equal(harness.authenticatedCount, 1);
});

test("full handshake: token -> PIN challenge -> correct response -> welcome; input flows only after", async () => {
  const harness = makeCtx(tempStateDir(), true);
  const channel = new FakeChannel();
  const session = createControllerSession(harness.ctx, channel, {
    clientId: "c1",
    onAuthenticated: () => harness.authenticatedCount++,
  });

  session.handleText(hello(TOKEN));
  assert.ok(channel.ofType("auth-required"), "expected PIN challenge after valid token");
  assert.equal(channel.ofType("welcome"), undefined, "no welcome before the PIN response");
  assert.equal(harness.authenticatedCount, 0, "video/attach callback must not fire pre-PIN");

  // Input sent BEFORE auth must be ignored (never dispatched).
  session.handleText(JSON.stringify({ type: "type", text: "sneak attack" }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.typed, []);

  session.handleText(answerChallenge(channel, PIN));
  assert.ok(channel.ofType("welcome"), "expected welcome after correct PIN");
  assert.equal(harness.authenticatedCount, 1);

  // Now input dispatches.
  session.handleText(JSON.stringify({ type: "type", text: "hello agent" }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.typed, ["hello agent"]);
});

test("wrong PIN responses exhaust the per-connection countdown and lock the client out", () => {
  const stateDir = tempStateDir();
  const harness = makeCtx(stateDir, true);
  const channel = new FakeChannel();
  const session = createControllerSession(harness.ctx, channel, { clientId: "bruteforcer" });

  session.handleText(hello(TOKEN));
  for (let i = 0; i < 5; i++) {
    const challenge = channel.ofType("auth-required");
    assert.ok(challenge);
    session.handleText(JSON.stringify({ type: "auth", response: `wrong-${i}` }));
    if (channel.closedWith) break;
  }
  assert.ok(channel.closedWith, "channel must close after repeated wrong PINs");
  assert.equal(channel.ofType("welcome"), undefined);
  assert.equal(harness.authenticatedCount, 0);

  // The lockout persists ACROSS connections (and across restarts — it's on disk): a fresh
  // connection from the same client is refused before it can even see a challenge.
  const channel2 = new FakeChannel();
  const session2 = createControllerSession(makeCtx(stateDir, true).ctx, channel2, { clientId: "bruteforcer" });
  session2.handleText(hello(TOKEN));
  const err = channel2.ofType("error");
  assert.equal(err?.code, "pin-locked");
  assert.ok((err?.retryAfterMs ?? 0) > 0, "lockout must tell the client when to retry");
  assert.equal(channel2.closedWith, "pin-locked");
});

test("messages before hello (or a non-hello first message) close the channel", () => {
  const { ctx } = makeCtx(tempStateDir(), true);
  const channel = new FakeChannel();
  const session = createControllerSession(ctx, channel, { clientId: "c1" });
  session.handleText(JSON.stringify({ type: "type", text: "no handshake" }));
  assert.equal(channel.closedWith, "expected hello");
});
