import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { IncomingMessage } from "node:http";
import { Layr8Client, unmarshalBody, ProblemReportError, ServerRejectError, logErrors, PASS } from "../src/index.js";
import type { Message, ErrorHandler } from "../src/index.js";
import { ErrorKind, SDKError } from "../src/index.js";

/** Discard all errors — used by tests that don't care about error callbacks. */
const discardErrors: ErrorHandler = () => {};

/** Minimal Phoenix Channel V2 mock server. */
class MockPhoenixServer {
  private wss: WebSocketServer;
  private client: WS | null = null;
  private received: Array<{ event: string; payload: unknown }> = [];
  onMsg: ((msg: { event: string; ref: string | null; topic: string; payload: unknown }) => void) | null = null;
  port: number;

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws: WS) => {
      this.client = ws;
      ws.on("message", (data: Buffer) => {
        const arr = JSON.parse(data.toString()) as unknown[];
        const msg = {
          joinRef: arr[0] as string | null,
          ref: arr[1] as string | null,
          topic: arr[2] as string,
          event: arr[3] as string,
          payload: arr[4],
        };
        this.received.push({ event: msg.event, payload: msg.payload });
        this.onMsg?.(msg);
      });
    });
  }

  sendToClient(joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown): void {
    if (this.client && this.client.readyState === WS.OPEN) {
      this.client.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    }
  }

  getReceived(): Array<{ event: string; payload: unknown }> {
    return [...this.received];
  }

  clearReceived(): void {
    this.received = [];
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let server: MockPhoenixServer;
let port: number;
let wsUrl: string;

// Use a random port range to avoid conflicts
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

async function setupServer(): Promise<MockPhoenixServer> {
  port = randomPort();
  wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
  server = new MockPhoenixServer(port);

  // Default: auto-reply to phx_join with ok, and ack all other messages
  server.onMsg = (msg) => {
    if (msg.event === "phx_join") {
      server.sendToClient(
        msg.ref,
        msg.ref,
        msg.topic,
        "phx_reply",
        { status: "ok", response: { did: "did:web:node:test" } },
      );
      return;
    }
    // Reply "ok" to all other messages (server ack)
    if (msg.ref) {
      server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
        status: "ok", response: {},
      });
    }
  };

  // Give server time to bind
  await delay(50);
  return server;
}

/**
 * Setup a server that returns reply_protocol/1 capability.
 * Collects all received events for assertions.
 */
async function setupReplyProtocolServer(): Promise<MockPhoenixServer> {
  port = randomPort();
  wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
  server = new MockPhoenixServer(port);

  server.onMsg = (msg) => {
    if (msg.event === "phx_join") {
      server.sendToClient(
        msg.ref,
        msg.ref,
        msg.topic,
        "phx_reply",
        {
          status: "ok",
          response: {
            did: "did:web:node:test",
            capabilities: ["reply_protocol/1"],
          },
        },
      );
      return;
    }
    // Reply "ok" to all other messages (server ack)
    if (msg.ref) {
      server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
        status: "ok", response: {},
      });
    }
  };

  await delay(50);
  return server;
}

describe("Layr8Client", () => {
  afterEach(async () => {
    if (server) await server.close();
  });

  it("creates a client with valid config", () => {
    const client = new Layr8Client(discardErrors, {
      nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    expect(client).toBeDefined();
  });

  it("throws when nodeUrl is missing", () => {
    expect(() => new Layr8Client(discardErrors, { apiKey: "test-key" })).toThrow(
      /nodeUrl is required/,
    );
  });

  it("throws when apiKey is missing", () => {
    expect(
      () => new Layr8Client(discardErrors, { nodeUrl: "ws://localhost:4000" }),
    ).toThrow(/apiKey is required/);
  });

  it("allows handle() before connect()", () => {
    const client = new Layr8Client(discardErrors, {
      nodeUrl: "ws://localhost:4000",
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    expect(() =>
      client.handle(
        "https://layr8.io/protocols/echo/1.0/request",
        async () => null,
      ),
    ).not.toThrow();
  });

  it("rejects handle() after connect()", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => null,
    );
    await client.connect();
    try {
      expect(() =>
        client.handle(
          "https://layr8.io/protocols/echo/1.0/response",
          async () => null,
        ),
      ).toThrow(/already connected/i);
    } finally {
      await client.close();
    }
  });

  it("connects and closes successfully", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    await client.connect();
    await client.close();
  });

  it("assigns DID from node when agentDid is empty", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "",
    });
    await client.connect();
    expect(client.did).toBe("did:web:node:test");
    await client.close();
  });

  it("rejects double connect()", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();
    try {
      await expect(client.connect()).rejects.toThrow(/already connected/i);
    } finally {
      await client.close();
    }
  });

  it("sends a message", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:bob"],
      body: { content: "hello" },
    });

    await delay(200);
    const received = server.getReceived();
    const msgEvents = received.filter((r) => r.event === "message");
    expect(msgEvents.length).toBeGreaterThan(0);

    await client.close();
  });

  it("rejects send() when not connected", async () => {
    const client = new Layr8Client(discardErrors, {
      nodeUrl: "ws://localhost:4000",
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    await expect(
      client.send({ type: "test", to: ["did:web:bob"] }),
    ).rejects.toThrow(/not connected/i);
  });

  it("correlates request/response by thread ID", async () => {
    await setupServer();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok",
          response: {},
        });
        return;
      }
      if (msg.event === "message") {
        // Send server ack first
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        // Then send the DIDComm response
        const outbound = msg.payload as { thid: string; from: string };
        server.sendToClient(null, null, "plugins:did:web:alice", "message", {
          plaintext: {
            id: "resp-1",
            type: "https://layr8.io/protocols/echo/1.0/response",
            from: "did:web:bob",
            to: [outbound.from],
            thid: outbound.thid,
            body: { echo: "hello" },
          },
        });
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    const resp = await client.request({
      type: "https://layr8.io/protocols/echo/1.0/request",
      to: ["did:web:bob"],
      body: { message: "hello" },
    });

    expect(resp.type).toBe("https://layr8.io/protocols/echo/1.0/response");
    const body = unmarshalBody<{ echo: string }>(resp as any);
    expect(body.echo).toBe("hello");

    await client.close();
  });

  it("request() times out via AbortSignal", async () => {
    await setupServer();

    // Override to NOT reply to messages (so request times out)
    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok", response: {},
        });
        return;
      }
      // Send server ack but no DIDComm response — request should time out
      if (msg.ref) {
        server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
          status: "ok", response: {},
        });
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    await expect(
      client.request(
        {
          type: "https://layr8.io/protocols/echo/1.0/request",
          to: ["did:web:nobody"],
          body: { message: "hello" },
        },
        { signal: AbortSignal.timeout(200) },
      ),
    ).rejects.toThrow();

    await client.close();
  });

  it("request() returns ProblemReportError", async () => {
    await setupServer();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok",
          response: {},
        });
        return;
      }
      if (msg.event === "message") {
        // Send server ack first
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        // Then send the problem report
        const outbound = msg.payload as { thid: string };
        server.sendToClient(null, null, "plugins:did:web:alice", "message", {
          plaintext: {
            id: "err-1",
            type: "https://didcomm.org/report-problem/2.0/problem-report",
            from: "did:web:bob",
            thid: outbound.thid,
            body: {
              code: "e.p.xfer.cant-process",
              comment: "database unavailable",
            },
          },
        });
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    try {
      await client.request({
        type: "https://layr8.io/protocols/echo/1.0/request",
        to: ["did:web:bob"],
        body: { message: "hello" },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemReportError);
      expect((err as ProblemReportError).code).toBe("e.p.xfer.cant-process");
    }

    await client.close();
  });

  it("dispatches inbound messages to handlers", async () => {
    await setupServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });

    const handlerCalled = new Promise<Message>((resolve) => {
      client.handle(
        "https://didcomm.org/basicmessage/2.0/message",
        async (msg) => {
          resolve(msg);
          return null;
        },
      );
    });

    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      context: {
        recipient: "did:web:alice",
        authorized: true,
        sender_credentials: [
          { credential_subject: { id: "did:web:bob", name: "Bob" } },
        ],
      },
      plaintext: {
        id: "inbound-1",
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: { content: "hello alice" },
      },
    });

    const msg = await handlerCalled;
    expect(msg.from).toBe("did:web:bob");
    expect(msg.context).toBeDefined();
    expect(msg.context!.authorized).toBe(true);
    expect(msg.context!.senderCredentials[0].name).toBe("Bob");
    const body = unmarshalBody<{ content: string }>(msg as any);
    expect(body.content).toBe("hello alice");

    // Verify ack was sent
    await delay(200);
    const received = server.getReceived();
    expect(received.some((r) => r.event === "ack")).toBe(true);

    await client.close();
  });

  it("auto-fills response fields in handler", async () => {
    await setupServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });

    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async (): Promise<Message> => ({
        id: "",
        type: "https://layr8.io/protocols/echo/1.0/response",
        from: "",
        to: [],
        threadId: "",
        parentThreadId: "",
        body: { echo: "pong" },
      }),
    );

    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-1",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        thid: "thread-abc",
        body: { message: "ping" },
      },
    });

    await delay(500);
    const received = server.getReceived();
    const responses = received.filter((r) => {
      if (r.event !== "message") return false;
      const p = r.payload as { type?: string };
      return p.type === "https://layr8.io/protocols/echo/1.0/response";
    });

    expect(responses.length).toBe(1);
    const resp = responses[0].payload as {
      from: string;
      to: string[];
      thid: string;
    };
    expect(resp.from).toBe("did:web:alice");
    expect(resp.to).toContain("did:web:bob");
    expect(resp.thid).toBe("thread-abc");

    await client.close();
  });

  it("handler error sends problem report", async () => {
    await setupServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });

    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => {
        throw new Error("something went wrong");
      },
    );

    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-1",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: { message: "ping" },
      },
    });

    await delay(500);
    const received = server.getReceived();
    const reports = received.filter((r) => {
      if (r.event !== "message") return false;
      const p = r.payload as { type?: string };
      return (
        p.type === "https://didcomm.org/report-problem/2.0/problem-report"
      );
    });

    expect(reports.length).toBe(1);

    await client.close();
  });

  it("includes server reason in join rejection error", async () => {
    await setupServer();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(
          msg.ref,
          msg.ref,
          msg.topic,
          "phx_reply",
          {
            status: "error",
            response: {
              reason: "e.connect.plugin.failed: protocols_already_bound",
            },
          },
        );
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);

    await expect(client.connect()).rejects.toThrow(/protocols_already_bound/);
  });

  it("handles concurrent requests correctly", async () => {
    await setupServer();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok",
          response: {},
        });
        return;
      }
      if (msg.event === "message") {
        // Send server ack first
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        // Then send the DIDComm response
        const outbound = msg.payload as {
          thid: string;
          body: { index: number };
        };
        server.sendToClient(null, null, "plugins:did:web:alice", "message", {
          plaintext: {
            id: `resp-${outbound.body.index}`,
            type: "https://layr8.io/protocols/echo/1.0/response",
            thid: outbound.thid,
            body: { index: outbound.body.index },
          },
        });
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    const n = 10;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        client.request({
          type: "https://layr8.io/protocols/echo/1.0/request",
          to: ["did:web:bob"],
          body: { index: i },
        }),
      ),
    );

    for (let i = 0; i < n; i++) {
      const body = unmarshalBody<{ index: number }>(results[i] as any);
      expect(body.index).toBe(i);
    }

    await client.close();
  });

  it("creates client with no arguments when env vars are set", () => {
    process.env.LAYR8_NODE_URL = "ws://localhost:4000/plugin_socket/websocket";
    process.env.LAYR8_API_KEY = "test-key";
    try {
      const client = new Layr8Client(discardErrors);
      expect(client).toBeDefined();
    } finally {
      delete process.env.LAYR8_NODE_URL;
      delete process.env.LAYR8_API_KEY;
    }
  });

  // ---------- Poka-yoke behavior tests ----------

  it("throws TypeError when ErrorHandler is missing", () => {
    expect(() => new Layr8Client(undefined as any, { nodeUrl: "ws://localhost", apiKey: "key" }))
      .toThrow(TypeError);
  });

  it("calls onError on parse failure", async () => {
    await setupServer();
    const errors: SDKError[] = [];
    const client = new Layr8Client((e) => errors.push(e), { nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test" });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    // Send garbage that can't be parsed as DIDComm
    server.sendToClient(null, null, "plugins:did:web:test", "message", "not-a-didcomm-message");
    await delay(200);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].kind).toBe(ErrorKind.ParseFailure);
    await client.close();
  });

  it("calls onError when no handler matches", async () => {
    await setupServer();
    const errors: SDKError[] = [];
    const client = new Layr8Client((e) => errors.push(e), { nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test" });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:test", "message", {
      plaintext: {
        id: "msg-1",
        type: "https://unknown.org/protocol/1.0/unknown",
        from: "did:web:other",
        body: {},
      },
    });
    await delay(200);

    expect(errors.length).toBe(1);
    expect(errors[0].kind).toBe(ErrorKind.NoHandler);
    await client.close();
  });

  it("calls onError when handler throws", async () => {
    await setupServer();
    const errors: SDKError[] = [];
    const client = new Layr8Client((e) => errors.push(e), { nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice" });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => { throw new Error("boom"); });
    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: { id: "req-1", type: "https://layr8.io/protocols/echo/1.0/request", from: "did:web:bob", body: {} },
    });
    await delay(500);

    expect(errors.some(e => e.kind === ErrorKind.HandlerException)).toBe(true);
    await client.close();
  });

  it("send() with fireAndForget skips server ack", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, { nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice" });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    // fireAndForget shouldn't need server ack
    await client.send(
      { type: "https://didcomm.org/basicmessage/2.0/message", to: ["did:web:bob"], body: { content: "hi" } },
      { fireAndForget: true },
    );

    await client.close();
  });

  it("send() throws when server rejects", async () => {
    await setupServer();
    // Override to reject messages
    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", { status: "ok", response: {} });
        return;
      }
      if (msg.ref) {
        server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
          status: "error", response: { reason: "not_authorized" },
        });
      }
    };

    const errors: SDKError[] = [];
    const client = new Layr8Client((e) => errors.push(e), { nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice" });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    // Server reject error is returned to the caller, not reported via onError
    try {
      await client.send({
        type: "https://didcomm.org/basicmessage/2.0/message", to: ["did:web:bob"], body: {},
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerRejectError);
      expect((err as ServerRejectError).reason).toBe("not_authorized");
    }

    expect(errors.some(e => e.kind === ErrorKind.ServerReject)).toBe(false);
    await client.close();
  });

  it("emits 'inbound' event for every received DIDComm message", async () => {
    await setupServer();

    const seen: Array<{ id: string; type: string; from?: string }> = [];

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.on("inbound", (msg: any) => {
      seen.push({ id: msg.id, type: msg.type, from: msg.from });
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    // Inject a message routed to the echo handler
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "inb-1",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: {},
      },
    });

    // Inject a thread-correlated reply
    server.onMsg = (msg) => {
      if (msg.event === "message") {
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        const outbound = msg.payload as { thid: string; from: string };
        server.sendToClient(null, null, "plugins:did:web:alice", "message", {
          plaintext: {
            id: "inb-2",
            type: "https://layr8.io/protocols/echo/1.0/response",
            from: "did:web:bob",
            to: [outbound.from],
            thid: outbound.thid,
            body: { echo: "ok" },
          },
        });
      }
    };

    await client.request({
      type: "https://layr8.io/protocols/echo/1.0/request",
      to: ["did:web:bob"],
      body: {},
    });

    await delay(100);

    expect(seen.find((m) => m.id === "inb-1")).toBeDefined();
    expect(seen.find((m) => m.id === "inb-2")).toBeDefined();

    await client.close();
  });

  it("emits 'outbound' event for send() and request()", async () => {
    await setupServer();

    const outbound: Array<{ id: string; type: string; to: string[] }> = [];

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok", response: {},
        });
        return;
      }
      if (msg.event === "message") {
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        const out = msg.payload as { thid?: string; from: string };
        // Reply only to the request() call (has thid we can echo back)
        if (out.thid) {
          server.sendToClient(null, null, "plugins:did:web:alice", "message", {
            plaintext: {
              id: "resp-x",
              type: "https://layr8.io/protocols/echo/1.0/response",
              from: "did:web:bob",
              to: [out.from],
              thid: out.thid,
              body: {},
            },
          });
        }
      }
    };

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.on("outbound", (msg: any) => {
      outbound.push({ id: msg.id, type: msg.type, to: msg.to });
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    await client.send({
      type: "https://didcomm.org/basicmessage/2.0/message",
      to: ["did:web:bob"],
      body: { content: "via send" },
    });

    await client.request({
      type: "https://layr8.io/protocols/echo/1.0/request",
      to: ["did:web:bob"],
      body: {},
    });

    await delay(50);

    expect(outbound.find((m) => m.type === "https://didcomm.org/basicmessage/2.0/message"))
      .toBeDefined();
    expect(outbound.find((m) => m.type === "https://layr8.io/protocols/echo/1.0/request"))
      .toBeDefined();

    await client.close();
  });

  it("emits 'outbound' for handler auto-responses", async () => {
    await setupServer();

    const outbound: string[] = [];

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:alice",
    });
    client.on("outbound", (msg: any) => {
      outbound.push(msg.type);
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => ({
        type: "https://layr8.io/protocols/echo/1.0/response",
        body: { echo: "auto" },
      }),
    );
    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "inb-auto",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: {},
      },
    });

    await delay(100);

    expect(outbound).toContain("https://layr8.io/protocols/echo/1.0/response");

    await client.close();
  });

  it("handleAll() catches messages with no specific handler", async () => {
    await setupServer();

    const caught: Array<{ type: string; id: string }> = [];
    const errors: SDKError[] = [];

    const client = new Layr8Client(
      (err: SDKError) => errors.push(err),
      {
        nodeUrl: wsUrl,
        apiKey: "test-key",
        agentDid: "did:web:alice",
      },
    );
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    client.handleAll(async (msg: any) => {
      caught.push({ type: msg.type, id: msg.id });
      return null;
    });
    await client.connect();

    // Deliver an unregistered type — should hit handleAll, not NoHandler error
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "inb-unhandled",
        type: "https://example.com/unregistered/1.0/notification",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: { hello: "world" },
      },
    });

    await delay(100);

    expect(caught).toEqual([
      { type: "https://example.com/unregistered/1.0/notification", id: "inb-unhandled" },
    ]);
    expect(errors.filter((e) => e.kind === ErrorKind.NoHandler)).toEqual([]);

    await client.close();
  });

  it("a throwing 'inbound' listener does not break request() correlation", async () => {
    await setupServer();

    const errors: SDKError[] = [];

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", {
          status: "ok", response: {},
        });
        return;
      }
      if (msg.event === "message") {
        if (msg.ref) {
          server.sendToClient(null, msg.ref, msg.topic, "phx_reply", {
            status: "ok", response: {},
          });
        }
        const out = msg.payload as { thid: string; from: string };
        server.sendToClient(null, null, "plugins:did:web:alice", "message", {
          plaintext: {
            id: "resp-after-throw",
            type: "https://layr8.io/protocols/echo/1.0/response",
            from: "did:web:bob",
            to: [out.from],
            thid: out.thid,
            body: { ok: true },
          },
        });
      }
    };

    const client = new Layr8Client(
      (err: SDKError) => errors.push(err),
      {
        nodeUrl: wsUrl,
        apiKey: "test-key",
        agentDid: "did:web:alice",
      },
    );
    client.on("inbound", () => {
      throw new Error("listener went boom");
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    // request() must still resolve despite the throwing listener
    const resp = await client.request({
      type: "https://layr8.io/protocols/echo/1.0/request",
      to: ["did:web:bob"],
      body: {},
    });

    expect(resp.id).toBe("resp-after-throw");
    expect(errors.some((e) => e.kind === ErrorKind.HandlerException)).toBe(true);

    await client.close();
  });

  it("falls through to NoHandler error when no default handler is set", async () => {
    await setupServer();

    const errors: SDKError[] = [];

    const client = new Layr8Client(
      (err: SDKError) => errors.push(err),
      {
        nodeUrl: wsUrl,
        apiKey: "test-key",
        agentDid: "did:web:alice",
      },
    );
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "inb-nodefault",
        type: "https://example.com/unregistered/1.0/notification",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: {},
      },
    });

    await delay(100);

    expect(errors.some((e) => e.kind === ErrorKind.NoHandler)).toBe(true);

    await client.close();
  });
});

describe("Layr8Client reply protocol", () => {
  afterEach(async () => {
    if (server) await server.close();
  });

  it("sends dispatch_reply with status handled when handler returns null", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => null,
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-1",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: { message: "ping" },
      },
    });

    await delay(300);
    const received = server.getReceived();
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    const payload = replies[0].payload as { message_id: string; status: string };
    expect(payload.status).toBe("handled");
    expect(payload.message_id).toBe("req-1");

    await client.close();
  });

  it("sends dispatch_reply with status handled when handler returns a message", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async (): Promise<Message> => ({
        id: "", type: "https://layr8.io/protocols/echo/1.0/response",
        from: "", to: [], threadId: "", parentThreadId: "",
        body: { echo: "pong" },
      }),
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-2",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        to: ["did:web:alice"],
        body: { message: "ping" },
      },
    });

    await delay(300);
    const received = server.getReceived();

    // Should send both the response message and dispatch_reply
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    expect((replies[0].payload as any).status).toBe("handled");

    const responses = received.filter((r) => {
      if (r.event !== "message") return false;
      return (r.payload as any).type === "https://layr8.io/protocols/echo/1.0/response";
    });
    expect(responses.length).toBe(1);

    await client.close();
  });

  it("sends dispatch_reply with status pass when no handler matches", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => null,
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "unknown-1",
        type: "https://unknown.org/protocol/1.0/unknown",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    const received = server.getReceived();
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    expect((replies[0].payload as any).status).toBe("pass");
    expect((replies[0].payload as any).message_id).toBe("unknown-1");

    await client.close();
  });

  it("sends dispatch_reply with status pass when handler returns PASS", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => PASS,
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-pass",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    const received = server.getReceived();
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    expect((replies[0].payload as any).status).toBe("pass");

    await client.close();
  });

  it("sends dispatch_reply with status error when handler throws", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => { throw new TypeError("bad input"); },
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-err",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    const received = server.getReceived();
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    const payload = replies[0].payload as { status: string; code: string; message: string };
    expect(payload.status).toBe("error");
    expect(payload.code).toBe("TypeError");
    expect(payload.message).toBe("bad input");

    await client.close();
  });

  it("does not send ack in new mode", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => null,
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "req-noack",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    const received = server.getReceived();
    expect(received.some((r) => r.event === "ack")).toBe(false);

    await client.close();
  });

  it("still sends ack in legacy mode (no capabilities)", async () => {
    await setupServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handle(
      "https://didcomm.org/basicmessage/2.0/message",
      async () => null,
    );
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "legacy-1",
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: "did:web:bob",
        body: { content: "hello" },
      },
    });

    await delay(300);
    const received = server.getReceived();
    expect(received.some((r) => r.event === "ack")).toBe(true);
    expect(received.some((r) => r.event === "dispatch_reply")).toBe(false);

    await client.close();
  });
});

describe("Layr8Client handleAll", () => {
  afterEach(async () => {
    if (server) await server.close();
  });

  it("handleAll registers catch-all and dispatches unmatched messages", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });

    const received: string[] = [];
    client.handleAll(async (msg) => {
      received.push(msg.type);
      return null;
    });
    await client.connect();

    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "any-1",
        type: "https://any.org/protocol/1.0/anything",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    expect(received).toContain("https://any.org/protocol/1.0/anything");

    await client.close();
  });

  it("specific handler takes priority over handleAll", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });

    const specificCalled: string[] = [];
    const catchAllCalled: string[] = [];

    client.handle(
      "https://layr8.io/protocols/echo/1.0/request",
      async (msg) => { specificCalled.push(msg.type); return null; },
    );
    client.handleAll(async (msg) => {
      catchAllCalled.push(msg.type);
      return null;
    });
    await client.connect();

    // Send a message that matches the specific handler
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "specific-1",
        type: "https://layr8.io/protocols/echo/1.0/request",
        from: "did:web:bob",
        body: {},
      },
    });
    // Send a message that falls through to catch-all
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "catchall-1",
        type: "https://other.org/protocol/1.0/msg",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    expect(specificCalled).toEqual(["https://layr8.io/protocols/echo/1.0/request"]);
    expect(catchAllCalled).toEqual(["https://other.org/protocol/1.0/msg"]);

    await client.close();
  });

  it("handleAll returning PASS sends dispatch_reply pass", async () => {
    await setupReplyProtocolServer();

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:alice",
    });
    client.handleAll(async () => PASS);
    await client.connect();

    server.clearReceived();
    server.sendToClient(null, null, "plugins:did:web:alice", "message", {
      plaintext: {
        id: "pass-1",
        type: "https://any.org/protocol/1.0/anything",
        from: "did:web:bob",
        body: {},
      },
    });

    await delay(300);
    const received = server.getReceived();
    const replies = received.filter((r) => r.event === "dispatch_reply");
    expect(replies.length).toBe(1);
    expect((replies[0].payload as any).status).toBe("pass");

    await client.close();
  });

  it("rejects handleAll() after connect()", async () => {
    await setupServer();
    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test",
    });
    await client.connect();
    expect(() => client.handleAll(async () => null)).toThrow(/already connected/i);
    await client.close();
  });
});

describe("Layr8Client protocol registration", () => {
  afterEach(async () => {
    if (server) await server.close();
  });

  it("always includes report-problem protocol in payload_types", async () => {
    let joinPayload: any = null;
    port = randomPort();
    wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
    server = new MockPhoenixServer(port);

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        joinPayload = msg.payload;
        server.sendToClient(
          msg.ref, msg.ref, msg.topic, "phx_reply",
          { status: "ok", response: { did: "did:web:node:test" } },
        );
      }
    };
    await delay(50);

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test",
    });
    client.handle("https://layr8.test/echo/1.0/request", async () => null);
    await client.connect();

    expect(joinPayload.payload_types).toContain("https://didcomm.org/report-problem/2.0");
    expect(joinPayload.payload_types).toContain("https://layr8.test/echo/1.0");
    await client.close();
  });

  it("does not duplicate report-problem if already registered", async () => {
    let joinPayload: any = null;
    port = randomPort();
    wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
    server = new MockPhoenixServer(port);

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        joinPayload = msg.payload;
        server.sendToClient(
          msg.ref, msg.ref, msg.topic, "phx_reply",
          { status: "ok", response: { did: "did:web:node:test" } },
        );
      }
    };
    await delay(50);

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test",
    });
    // Register a handler for problem-report explicitly
    client.handle("https://didcomm.org/report-problem/2.0/problem-report", async () => null);
    await client.connect();

    const count = joinPayload.payload_types.filter(
      (p: string) => p === "https://didcomm.org/report-problem/2.0"
    ).length;
    expect(count).toBe(1);
    await client.close();
  });

  it("skips report-problem when catch-all (*) is registered", async () => {
    let joinPayload: any = null;
    port = randomPort();
    wsUrl = `ws://127.0.0.1:${port}/plugin_socket/websocket`;
    server = new MockPhoenixServer(port);

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        joinPayload = msg.payload;
        server.sendToClient(
          msg.ref, msg.ref, msg.topic, "phx_reply",
          { status: "ok", response: { did: "did:web:node:test" } },
        );
      }
    };
    await delay(50);

    const client = new Layr8Client(discardErrors, {
      nodeUrl: wsUrl, apiKey: "test-key", agentDid: "did:web:test",
    });
    client.handleAll(async () => null);
    await client.connect();

    // With *, no need for explicit report-problem
    expect(joinPayload.payload_types).toContain("*");
    expect(joinPayload.payload_types).not.toContain("https://didcomm.org/report-problem/2.0");
    await client.close();
  });
});
