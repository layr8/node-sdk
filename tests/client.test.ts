import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { IncomingMessage } from "node:http";
import { Layr8Client, unmarshalBody, ProblemReportError } from "../src/index.js";
import type { Message } from "../src/index.js";

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

  // Default: auto-reply to phx_join with ok
  server.onMsg = (msg) => {
    if (msg.event === "phx_join") {
      server.sendToClient(
        msg.ref,
        msg.ref,
        msg.topic,
        "phx_reply",
        { status: "ok", response: { did: "did:web:node:test" } },
      );
    }
  };

  // Give server time to bind
  await delay(50);
  return server;
}

describe("Layr8Client", () => {
  afterEach(async () => {
    if (server) await server.close();
  });

  it("creates a client with valid config", () => {
    const client = new Layr8Client({
      nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    expect(client).toBeDefined();
  });

  it("throws when nodeUrl is missing", () => {
    expect(() => new Layr8Client({ apiKey: "test-key" })).toThrow(
      /nodeUrl is required/,
    );
  });

  it("throws when apiKey is missing", () => {
    expect(
      () => new Layr8Client({ nodeUrl: "ws://localhost:4000" }),
    ).toThrow(/apiKey is required/);
  });

  it("allows handle() before connect()", () => {
    const client = new Layr8Client({
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
    const client = new Layr8Client({
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
    const client = new Layr8Client({
      nodeUrl: wsUrl,
      apiKey: "test-key",
      agentDid: "did:web:test",
    });
    await client.connect();
    await client.close();
  });

  it("assigns DID from node when agentDid is empty", async () => {
    await setupServer();
    const client = new Layr8Client({
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
    const client = new Layr8Client({
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
    const client = new Layr8Client({
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
    const client = new Layr8Client({
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

    const client = new Layr8Client({
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
    const client = new Layr8Client({
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

    const client = new Layr8Client({
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

    const client = new Layr8Client({
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

    server.sendToClient(null, null, "plugin:lobby", "message", {
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

    const client = new Layr8Client({
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

    server.sendToClient(null, null, "plugin:lobby", "message", {
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

    const client = new Layr8Client({
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

    server.sendToClient(null, null, "plugin:lobby", "message", {
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

    const client = new Layr8Client({
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

    const client = new Layr8Client({
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
      const client = new Layr8Client();
      expect(client).toBeDefined();
    } finally {
      delete process.env.LAYR8_NODE_URL;
      delete process.env.LAYR8_API_KEY;
    }
  });
});
