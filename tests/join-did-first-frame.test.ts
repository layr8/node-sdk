// A message the node routes to a joined DID in the same read as the join reply.
//
// The node starts routing to a DID's Channel the moment it accepts the join, so
// the first message for that DID can be on the wire right behind the
// `phx_reply`. `ws` parses every frame of one TCP read and emits them back to
// back, with no microtask checkpoint in between, so the second frame is
// dispatched before the `await channel.join(...)` in `joinDid` has resumed.
// When the per-DID handlers were only installed after that await, the message
// found no handler and was dropped as `NoHandler`. Observed in production as a
// message for a DID that was being re-joined: reported `NoHandler`, and lost.

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { ErrorKind, Layr8Client, type ErrorHandler } from "../src/index.js";
import { delay, ephemeralServer, readyUrl } from "./helpers/mock-ws-server.js";

const ALICE = "did:web:alice";
const BOB = "did:web:bob";
const TYPE = "https://example.org/p/1.0/req";

let wss: WebSocketServer | undefined;

afterEach(async () => {
  if (wss) await new Promise<void>((r) => wss!.close(() => r()));
  wss = undefined;
});

/**
 * A node that answers every join, and for `plugins:<firstFrameFor>` writes the
 * join reply AND one message in a single socket write, so the client reads
 * them together.
 */
async function nodeSendingWithTheJoinReply(firstFrameFor: string): Promise<string> {
  wss = ephemeralServer();
  wss.on("connection", (ws: WS) => {
    ws.on("message", (data: Buffer) => {
      const [joinRef, ref, topic, event] = JSON.parse(data.toString()) as [string | null, string | null, string, string];
      if (event === "phx_join") {
        const reply = JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: { did: topic.replace("plugins:", "") } }]);
        if (topic !== `plugins:${firstFrameFor}`) {
          ws.send(reply);
          return;
        }
        const message = JSON.stringify([null, null, topic, "message", { plaintext: { id: "m1", type: TYPE, from: "did:web:peer", body: {} } }]);
        const socket = (ws as unknown as { _socket: import("node:net").Socket })._socket;
        socket.cork();
        ws.send(reply);
        ws.send(message);
        socket.uncork();
        return;
      }
      if (ref) ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
    });
  });
  return readyUrl(wss);
}

describe("joinDid — a message that arrives with the join reply", () => {
  it("is given to the DID's own handler, not reported NoHandler", async () => {
    const url = await nodeSendingWithTheJoinReply(BOB);
    const errors: string[] = [];
    const onError: ErrorHandler = (err) => {
      const kind = (err as { kind?: ErrorKind }).kind;
      errors.push(kind === undefined ? String(err) : ErrorKind[kind]);
    };
    const client = new Layr8Client(onError, { nodeUrl: url, apiKey: "test-key", agentDid: ALICE });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    const seen: string[] = [];
    try {
      await client.connect();
      await client.joinDid(BOB, {
        protocols: ["https://example.org/p/1.0"],
        handlers: { [TYPE]: async (msg) => { seen.push(msg.id); return null; } },
      });
      await delay(100);
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
    expect(seen).toEqual(["m1"]);
  });
});

/**
 * A node for the cases below: answers every join (with `capabilities` when
 * given), writes `held` messages for `plugins:<firstFrameFor>` in the same
 * socket write as that join's reply, rejects that join when `reject` is set,
 * and records every frame the client sends.
 */
async function scriptedNode(opts: {
  firstFrameFor: string;
  held: unknown[];
  capabilities?: string[];
  reject?: boolean;
}): Promise<{ url: string; sent: Array<{ topic: string; event: string; payload: unknown }> }> {
  const sent: Array<{ topic: string; event: string; payload: unknown }> = [];
  wss = ephemeralServer();
  wss.on("connection", (ws: WS) => {
    ws.on("message", (data: Buffer) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(data.toString()) as [string | null, string | null, string, string, unknown];
      sent.push({ topic, event, payload });
      if (event === "phx_join") {
        const target = topic === `plugins:${opts.firstFrameFor}`;
        const status = target && opts.reject ? { status: "error", response: { reason: "test_reject" } } : {
          status: "ok",
          response: { did: topic.replace("plugins:", ""), ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) },
        };
        const reply = JSON.stringify([joinRef, ref, topic, "phx_reply", status]);
        if (!target) {
          ws.send(reply);
          return;
        }
        const socket = (ws as unknown as { _socket: import("node:net").Socket })._socket;
        socket.cork();
        ws.send(reply);
        for (const m of opts.held) ws.send(JSON.stringify([null, null, topic, "message", m]));
        socket.uncork();
        return;
      }
      if (ref) ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
    });
  });
  return { url: await readyUrl(wss), sent };
}

const plain = (id: string) => ({ plaintext: { id, type: TYPE, from: "did:web:peer", body: {} } });

function recordingClient(url: string, errors: Array<{ kind: string; messageId: string }>): Layr8Client {
  const onError: ErrorHandler = (err) => {
    const e = err as { kind?: ErrorKind; messageId?: string };
    errors.push({ kind: e.kind === undefined ? String(err) : ErrorKind[e.kind], messageId: e.messageId ?? "" });
  };
  const client = new Layr8Client(onError, { nodeUrl: url, apiKey: "test-key", agentDid: ALICE });
  client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
  return client;
}

describe("joinDid — what a held message's handler sees", () => {
  it("runs after joinDid resolved: the handler can send as the DID through the returned handle", async () => {
    const node = await scriptedNode({ firstFrameFor: BOB, held: [plain("m1")] });
    const errors: Array<{ kind: string; messageId: string }> = [];
    const client = recordingClient(node.url, errors);
    const outcome: string[] = [];
    try {
      await client.connect();
      // eslint-disable-next-line prefer-const
      let handle: Awaited<ReturnType<typeof client.joinDid>> | undefined;
      handle = await client.joinDid(BOB, {
        protocols: ["https://example.org/p/1.0"],
        handlers: {
          [TYPE]: async () => {
            try {
              if (!handle) throw new Error("handler ran before joinDid resolved");
              await handle.send({ to: ["did:web:peer"], type: "https://example.org/p/1.0/res", body: {} });
              outcome.push("sent");
            } catch (err) {
              outcome.push(`threw: ${(err as Error).message}`);
            }
            return null;
          },
        },
      });
      await delay(150);
    } finally {
      await client.close();
    }
    expect(outcome).toEqual(["sent"]);
    expect(errors).toEqual([]);
    const out = node.sent.filter((f) => f.topic === `plugins:${BOB}` && f.event === "message");
    expect(out).toHaveLength(1);
  });

  it("is answered with dispatch_reply when the join negotiated reply_protocol/1", async () => {
    const node = await scriptedNode({ firstFrameFor: BOB, held: [plain("m1")], capabilities: ["reply_protocol/1"] });
    const errors: Array<{ kind: string; messageId: string }> = [];
    const client = recordingClient(node.url, errors);
    try {
      await client.connect();
      await client.joinDid(BOB, {
        protocols: ["https://example.org/p/1.0"],
        handlers: { [TYPE]: async () => null },
      });
      await delay(150);
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
    const replies = node.sent.filter((f) => f.topic === `plugins:${BOB}` && f.event === "dispatch_reply");
    expect(replies.map((r) => r.payload)).toEqual([{ message_id: "m1", status: "handled" }]);
    expect(node.sent.some((f) => f.topic === `plugins:${BOB}` && f.event === "ack")).toBe(false);
  });

  it("is replayed in arrival order", async () => {
    const node = await scriptedNode({ firstFrameFor: BOB, held: [plain("m1"), plain("m2"), plain("m3")] });
    const errors: Array<{ kind: string; messageId: string }> = [];
    const client = recordingClient(node.url, errors);
    const seen: string[] = [];
    try {
      await client.connect();
      await client.joinDid(BOB, {
        protocols: ["https://example.org/p/1.0"],
        handlers: { [TYPE]: async (msg) => { seen.push(msg.id); return null; } },
      });
      await delay(150);
    } finally {
      await client.close();
    }
    expect(seen).toEqual(["m1", "m2", "m3"]);
    expect(errors).toEqual([]);
  });

  it("is reported HeldMessageDropped, one report per message, when the join fails", async () => {
    const node = await scriptedNode({ firstFrameFor: BOB, held: [plain("m1"), plain("m2")], reject: true });
    const errors: Array<{ kind: string; messageId: string }> = [];
    const client = recordingClient(node.url, errors);
    const seen: string[] = [];
    try {
      await client.connect();
      await expect(
        client.joinDid(BOB, {
          protocols: ["https://example.org/p/1.0"],
          handlers: { [TYPE]: async (msg) => { seen.push(msg.id); return null; } },
        }),
      ).rejects.toThrow();
      await delay(100);
    } finally {
      await client.close();
    }
    expect(seen).toEqual([]);
    expect(errors).toEqual([
      { kind: "HeldMessageDropped", messageId: "m1" },
      { kind: "HeldMessageDropped", messageId: "m2" },
    ]);
  });

  it("holds at most MAX_HELD_MESSAGES and reports each one over the bound", async () => {
    const { MAX_HELD_MESSAGES } = await import("../src/channel.js");
    const held = Array.from({ length: MAX_HELD_MESSAGES + 2 }, (_, i) => plain(`m${i}`));
    const node = await scriptedNode({ firstFrameFor: BOB, held });
    const errors: Array<{ kind: string; messageId: string }> = [];
    const client = recordingClient(node.url, errors);
    const seen: string[] = [];
    try {
      await client.connect();
      await client.joinDid(BOB, {
        protocols: ["https://example.org/p/1.0"],
        handlers: { [TYPE]: async (msg) => { seen.push(msg.id); return null; } },
      });
      await delay(300);
    } finally {
      await client.close();
    }
    expect(seen).toHaveLength(MAX_HELD_MESSAGES);
    expect(errors).toEqual([
      { kind: "HeldMessageDropped", messageId: `m${MAX_HELD_MESSAGES}` },
      { kind: "HeldMessageDropped", messageId: `m${MAX_HELD_MESSAGES + 1}` },
    ]);
  });
});
