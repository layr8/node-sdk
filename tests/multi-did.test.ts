// Multi-DID surface tests — `Layr8Client.joinDid` / `leaveDid` /
// `DidHandle.send` / per-DID handler dispatch / topic routing.
//
// These exercise the W0 (multi-channel over one WS) surface: a single
// `Layr8Client` holds one Connection and N joined Channels; inbound frames
// route by topic to the right Channel; per-DID handlers fire first, with
// the client-global registry as the fallback.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { Layr8Client, NotConnectedError, type ErrorHandler } from "../src/index.js";

const discardErrors: ErrorHandler = () => {};

/** Minimal Phoenix Channel V2 mock server. Auto-replies "ok" to phx_join +
 *  any tracked send. Tracks `joined` topics and lets tests push messages
 *  on a specific topic. */
class MockServer {
  private wss: WebSocketServer;
  private client: WS | null = null;
  readonly joinedTopics: string[] = [];
  readonly sent: Array<{ event: string; topic: string; payload: unknown }> = [];
  readonly port: number;

  /**
   * Reject the next N phx_join attempts for the given topic with
   * `{status: "error", response: {reason: "test_reject"}}`. Each rejection
   * decrements the counter; once 0, subsequent joins are accepted as
   * normal. Used to exercise reconnect-time rejoin failure paths.
   */
  readonly rejectJoinAttempts = new Map<string, number>();

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws: WS) => {
      this.client = ws;
      ws.on("message", (data: Buffer) => {
        const arr = JSON.parse(data.toString()) as unknown[];
        const ref = arr[1] as string | null;
        const topic = arr[2] as string;
        const event = arr[3] as string;
        const payload = arr[4];
        this.sent.push({ event, topic, payload });

        if (event === "phx_join") {
          const rejectsLeft = this.rejectJoinAttempts.get(topic) ?? 0;
          if (rejectsLeft > 0) {
            this.rejectJoinAttempts.set(topic, rejectsLeft - 1);
            ws.send(JSON.stringify([
              ref, ref, topic, "phx_reply",
              { status: "error", response: { reason: "test_reject" } },
            ]));
            return;
          }
          this.joinedTopics.push(topic);
          ws.send(JSON.stringify([
            ref, ref, topic, "phx_reply",
            { status: "ok", response: { did: topic.replace("plugins:", "") } },
          ]));
          return;
        }
        if (event === "phx_leave") return; // no reply needed
        if (ref) {
          ws.send(JSON.stringify([
            null, ref, topic, "phx_reply",
            { status: "ok", response: {} },
          ]));
        }
      });
    });
  }

  sendOnTopic(topic: string, payload: unknown): void {
    if (this.client && this.client.readyState === WS.OPEN) {
      this.client.send(JSON.stringify([null, null, topic, "message", payload]));
    }
  }

  /**
   * Force-close the server-side socket to simulate a connection drop.
   * The client's WS will see this as a "close" event and start its
   * reconnect backoff loop.
   */
  dropClient(): void {
    if (this.client) {
      this.client.terminate();
      this.client = null;
    }
  }

  async close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

let server: MockServer;
let wsUrl: string;

beforeEach(async () => {
  const port = randomPort();
  wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
  server = new MockServer(port);
  await delay(50);
});

afterEach(async () => {
  if (server) await server.close();
});

const ALICE = "did:web:alice";
const BOB = "did:web:bob";
const CAROL = "did:web:carol";

function newClient() {
  const client = new Layr8Client(discardErrors, {
    nodeUrl: wsUrl,
    apiKey: "test-key",
    agentDid: ALICE,
  });
  // Make sure connect's protocol-derivation produces a non-empty payload
  // by registering at least one handler.
  client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
  return client;
}

describe("Layr8Client multi-DID — joinDid / leaveDid lifecycle", () => {
  it("throws NotConnectedError when joinDid is called before connect()", async () => {
    const client = newClient();
    await expect(
      client.joinDid(BOB, { protocols: ["https://example.org/p/1.0"] }),
    ).rejects.toThrow(NotConnectedError);
  });

  it("sends a second phx_join for the new DID's topic over the same WS", async () => {
    const client = newClient();
    await client.connect();
    expect(server.joinedTopics).toEqual([`plugins:${ALICE}`]);

    const bob = await client.joinDid(BOB, {
      protocols: ["https://example.org/p/1.0"],
    });

    expect(bob.did).toBe(BOB);
    expect(server.joinedTopics).toEqual([
      `plugins:${ALICE}`,
      `plugins:${BOB}`,
    ]);
    await client.close();
  });

  it("rejects joinDid when the DID equals the primary agentDid", async () => {
    const client = newClient();
    await client.connect();
    await expect(
      client.joinDid(ALICE, { protocols: ["x"] }),
    ).rejects.toThrow(/already hosted by connect/i);
    await client.close();
  });

  it("rejects joinDid when the DID is already joined", async () => {
    const client = newClient();
    await client.connect();
    await client.joinDid(BOB, { protocols: ["x"] });
    await expect(
      client.joinDid(BOB, { protocols: ["x"] }),
    ).rejects.toThrow(/already joined/i);
    await client.close();
  });

  it("leaveDid sends phx_leave for the DID's topic and removes the Channel", async () => {
    const client = newClient();
    await client.connect();
    await client.joinDid(BOB, { protocols: ["x"] });

    const sentBefore = server.sent.length;
    await client.leaveDid(BOB);
    await delay(20);

    const newSends = server.sent.slice(sentBefore);
    const leave = newSends.find((s) => s.event === "phx_leave" && s.topic === `plugins:${BOB}`);
    expect(leave).toBeDefined();

    await client.close();
  });

  it("leaveDid is a no-op for an unknown DID", async () => {
    const client = newClient();
    await client.connect();
    // Should not throw.
    await client.leaveDid("did:web:never-joined");
    await client.close();
  });

  it("close() leaves every additional Channel before tearing down the WS", async () => {
    const client = newClient();
    await client.connect();
    await client.joinDid(BOB, { protocols: ["x"] });
    await client.joinDid(CAROL, { protocols: ["x"] });

    const sentBefore = server.sent.length;
    await client.close();
    await delay(20);

    const leaves = server.sent.slice(sentBefore).filter((s) => s.event === "phx_leave");
    const topics = leaves.map((l) => l.topic).sort();
    expect(topics).toEqual([`plugins:${BOB}`, `plugins:${CAROL}`].sort());
  });
});

describe("Layr8Client multi-DID — inbound routing by topic", () => {
  it("routes inbound messages to the per-DID handler when registered", async () => {
    const client = newClient();
    await client.connect();

    const seen: Array<{ did: string; ack: string }> = [];
    const bobHandler = async (msg: any) => {
      seen.push({ did: "bob", ack: msg.id });
      return null;
    };

    await client.joinDid(BOB, {
      protocols: ["https://example.org/p/1.0/req"],
      handlers: { "https://example.org/p/1.0/req": bobHandler },
    });

    server.sendOnTopic(`plugins:${BOB}`, {
      plaintext: {
        id: "m1",
        type: "https://example.org/p/1.0/req",
        from: "did:web:peer",
        body: {},
      },
    });
    await delay(100);

    expect(seen).toEqual([{ did: "bob", ack: "m1" }]);
    await client.close();
  });

  it("falls back to the client-global handler when the per-DID registry has no match", async () => {
    const seen: string[] = [];
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: ALICE,
    });
    client.handle("https://example.org/p/1.0/req", async (msg) => {
      seen.push(`global:${msg.id}`);
      return null;
    });
    await client.connect();

    await client.joinDid(BOB, {
      protocols: ["https://example.org/p/1.0/req"],
      // No per-DID handler for this type — should fall back to client-global.
      handlers: { "https://example.org/other/1.0/x": async () => null },
    });

    server.sendOnTopic(`plugins:${BOB}`, {
      plaintext: {
        id: "m2",
        type: "https://example.org/p/1.0/req",
        from: "did:web:peer",
        body: {},
      },
    });
    await delay(100);

    expect(seen).toEqual(["global:m2"]);
    await client.close();
  });

  it("per-DID handler overrides client-global for the SAME message type", async () => {
    const seen: string[] = [];
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: ALICE,
    });
    client.handle("https://example.org/p/1.0/req", async (msg) => {
      seen.push(`global:${msg.id}`);
      return null;
    });
    await client.connect();

    await client.joinDid(BOB, {
      protocols: ["https://example.org/p/1.0/req"],
      handlers: {
        "https://example.org/p/1.0/req": async (msg) => {
          seen.push(`bob:${msg.id}`);
          return null;
        },
      },
    });

    // Primary DID receives → global handler.
    server.sendOnTopic(`plugins:${ALICE}`, {
      plaintext: {
        id: "to-alice",
        type: "https://example.org/p/1.0/req",
        from: "did:web:peer",
        body: {},
      },
    });
    // Bob DID receives → per-DID handler (overrides global for this DID).
    server.sendOnTopic(`plugins:${BOB}`, {
      plaintext: {
        id: "to-bob",
        type: "https://example.org/p/1.0/req",
        from: "did:web:peer",
        body: {},
      },
    });
    await delay(150);

    expect(seen.sort()).toEqual(["bob:to-bob", "global:to-alice"]);
    await client.close();
  });

  it("messages on an unrelated topic do not reach any handler", async () => {
    const errors: any[] = [];
    const client = new Layr8Client((e) => errors.push(e), {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: ALICE,
    });
    const fired: string[] = [];
    client.handle("https://example.org/p/1.0/req", async (msg) => {
      fired.push(msg.id);
      return null;
    });
    await client.connect();

    server.sendOnTopic(`plugins:did:web:never-joined`, {
      plaintext: {
        id: "ghost",
        type: "https://example.org/p/1.0/req",
        from: "did:web:peer",
        body: {},
      },
    });
    await delay(100);

    expect(fired).toEqual([]);
    expect(errors).toEqual([]);
    await client.close();
  });
});

describe("Layr8Client multi-DID — reconnect", () => {
  it("rejoins every Channel after the WS drops", async () => {
    const client = newClient();
    await client.connect();
    await client.joinDid(BOB, { protocols: ["x"] });
    await client.joinDid(CAROL, { protocols: ["x"] });

    // Sanity: each topic joined exactly once so far.
    expect(server.joinedTopics.filter((t) => t === `plugins:${ALICE}`).length).toBe(1);
    expect(server.joinedTopics.filter((t) => t === `plugins:${BOB}`).length).toBe(1);
    expect(server.joinedTopics.filter((t) => t === `plugins:${CAROL}`).length).toBe(1);

    const reconnected = new Promise<void>((resolve) =>
      client.once("reconnect", resolve),
    );
    server.dropClient();
    await reconnected;

    // After reconnect, every Channel has rejoined exactly once on top of
    // the original join — so each topic appears in `joinedTopics` twice.
    expect(server.joinedTopics.filter((t) => t === `plugins:${ALICE}`).length).toBe(2);
    expect(server.joinedTopics.filter((t) => t === `plugins:${BOB}`).length).toBe(2);
    expect(server.joinedTopics.filter((t) => t === `plugins:${CAROL}`).length).toBe(2);

    // All three Channels can send again post-reconnect.
    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:peer"],
      body: { content: "alice post-reconnect" },
    });

    await client.close();
  }, 15_000);

  it("isolates a single Channel's rejoin failure — others rejoin and serve normally", async () => {
    // W1 / shared multi-tenant gateway concern: when the WS drops and one
    // Instance Channel's rejoin is rejected by the server (e.g. the
    // Instance was revoked, the DID's auth changed mid-flight), the OTHER
    // joined Channels must continue to serve. Without per-channel isolation,
    // a single Instance failure would stall the whole gateway.
    const client = newClient();
    await client.connect();
    const bob = await client.joinDid(BOB, { protocols: ["x"] });
    await client.joinDid(CAROL, { protocols: ["x"] });

    // After the drop, the server will reject Bob's rejoin with an error
    // reply, while Alice and Carol rejoin normally.
    server.rejectJoinAttempts.set(`plugins:${BOB}`, 99);

    const reconnected = new Promise<void>((resolve) =>
      client.once("reconnect", resolve),
    );
    server.dropClient();
    await reconnected;

    // Alice + Carol rejoined; Bob did not.
    expect(server.joinedTopics.filter((t) => t === `plugins:${ALICE}`).length).toBe(2);
    expect(server.joinedTopics.filter((t) => t === `plugins:${CAROL}`).length).toBe(2);
    expect(server.joinedTopics.filter((t) => t === `plugins:${BOB}`).length).toBe(1);

    // Alice and Carol can still send.
    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:peer"],
      body: { content: "alice survives" },
    });

    // Bob's Channel is not joined — send must surface NotConnectedError
    // rather than silently writing to the wire where the cloud-node has
    // no subscription. This is what the `!this.joined` guard in
    // Channel.send was added for.
    await expect(
      bob.send({
        type: "https://didcomm.org/basicmessage/2.0/message",
        to: ["did:web:peer"],
        body: { content: "bob is stuck" },
      }),
    ).rejects.toThrow(NotConnectedError);

    await client.close();
  }, 15_000);

  it("single-DID rejoin failure retries the reconnect backoff loop", async () => {
    // Single-DID parity with the pre-refactor PhoenixChannel: a transient
    // server hiccup that rejects the first rejoin must trigger the outer
    // backoff retry, not silently leave the client in a "reconnected but
    // unjoined" state. Ember (single-DID) relies on this.
    const client = newClient();
    await client.connect();

    // Reject the FIRST rejoin attempt — backoff will fire a SECOND attempt
    // ~1s later, which the server accepts.
    server.rejectJoinAttempts.set(`plugins:${ALICE}`, 1);

    const reconnected = new Promise<void>((resolve) =>
      client.once("reconnect", resolve),
    );
    server.dropClient();
    await reconnected;

    // The initial join (1) plus the second rejoin attempt (1) means Alice
    // is in joinedTopics exactly twice; the first rejected attempt did
    // NOT increment joinedTopics (the mock only records accepted joins).
    expect(server.joinedTopics.filter((t) => t === `plugins:${ALICE}`).length).toBe(2);
    // And the client can send again post-recovery.
    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:peer"],
      body: { content: "alice recovered" },
    });

    await client.close();
  }, 15_000);
});

describe("Layr8Client multi-DID — DidHandle.send", () => {
  it("DidHandle.send writes to the DID's own topic", async () => {
    const client = newClient();
    await client.connect();
    const bob = await client.joinDid(BOB, { protocols: ["x"] });

    const sentBefore = server.sent.length;
    await bob.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:peer"],
      body: { content: "hi from bob" },
    });
    await delay(50);

    const newSends = server.sent.slice(sentBefore);
    const msg = newSends.find((s) => s.event === "message");
    expect(msg).toBeDefined();
    expect(msg!.topic).toBe(`plugins:${BOB}`);
    // The DIDComm wire stamps `from = bob` because DidHandle.send sets it.
    const payload = msg!.payload as { from: string };
    expect(payload.from).toBe(BOB);

    await client.close();
  });

  it("client.send still uses the PRIMARY DID's topic (back-compat)", async () => {
    const client = newClient();
    await client.connect();
    await client.joinDid(BOB, { protocols: ["x"] });

    const sentBefore = server.sent.length;
    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:peer"],
      body: { content: "hi from alice" },
    });
    await delay(50);

    const newSends = server.sent.slice(sentBefore);
    const msg = newSends.find((s) => s.event === "message");
    expect(msg!.topic).toBe(`plugins:${ALICE}`);
    const payload = msg!.payload as { from: string };
    expect(payload.from).toBe(ALICE);

    await client.close();
  });
});
