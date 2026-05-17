import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { MockPhoenixServer } from "./mock-server.js";

describe("MockPhoenixServer", () => {
  let server: MockPhoenixServer;

  beforeAll(async () => {
    server = new MockPhoenixServer();
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it("accepts a phx_join and returns did + capabilities", async () => {
    const ws = new WebSocket(server.wsUrl);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const reply = new Promise<unknown>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[3] === "phx_reply") resolve(msg[4]);
      });
    });

    // [join_ref, ref, topic, event, payload]
    ws.send(JSON.stringify(["1", "1", "plugins:did:web:test:agent-1", "phx_join", {
      did_spec: {},
      protocols: ["reply_protocol/1"],
    }]));

    const result = await reply as { status: string; response: { did: string; capabilities: string[] } };
    expect(result.status).toBe("ok");
    expect(result.response.did).toBe("did:web:test:agent-1");
    expect(result.response.capabilities).toContain("reply_protocol/1");
    ws.close();
  });

  it("relays messages between two connected clients", async () => {
    const ws1 = new WebSocket(server.wsUrl);
    const ws2 = new WebSocket(server.wsUrl);
    await Promise.all([
      new Promise<void>((r) => ws1.on("open", r)),
      new Promise<void>((r) => ws2.on("open", r)),
    ]);

    // Join both
    ws1.send(JSON.stringify(["1", "1", "plugins:did:web:test:sender", "phx_join", {
      did_spec: {}, protocols: ["reply_protocol/1"],
    }]));
    ws2.send(JSON.stringify(["1", "1", "plugins:did:web:test:receiver", "phx_join", {
      did_spec: {}, protocols: ["reply_protocol/1"],
    }]));

    // Wait for join replies
    await new Promise((r) => setTimeout(r, 50));

    // Listen for message on ws2
    const received = new Promise<unknown>((resolve) => {
      ws2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[3] === "message") resolve(msg[4]);
      });
    });

    // ws1 sends a message addressed to receiver
    const envelope = JSON.stringify({
      id: "msg-1",
      type: "https://layr8.test/echo/1.0/request",
      from: "did:web:test:sender",
      to: ["did:web:test:receiver"],
      thid: "thread-1",
      body: { ping: "hello" },
    });

    ws1.send(JSON.stringify([null, "2", "plugins:did:web:test:sender", "message", envelope]));

    const payload = await received as { context: unknown; plaintext: string };
    expect(payload.plaintext).toBe(envelope);
    expect(payload.context).toBeDefined();

    ws1.close();
    ws2.close();
  });
});