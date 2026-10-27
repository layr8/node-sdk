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
