import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { PhoenixChannel } from "../src/channel.js";
import { NotConnectedError } from "../src/errors.js";
import type { DidSpec } from "../src/config.js";
import { delay, ephemeralServer, readyUrl } from "./helpers/mock-ws-server.js";

/** Minimal Phoenix Channel V2 mock server. */
class MockPhoenixServer {
  private wss: WebSocketServer;
  private client: WS | null = null;
  onMsg: ((msg: { event: string; ref: string | null; topic: string; payload: unknown; joinRef: string | null }) => void) | null = null;

  constructor() {
    this.wss = ephemeralServer();
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
        this.onMsg?.(msg);
      });
    });
  }

  /** Resolve with the ws:// URL once the kernel has assigned a port. */
  ready(): Promise<string> {
    return readyUrl(this.wss);
  }

  sendToClient(joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown): void {
    if (this.client && this.client.readyState === WS.OPEN) {
      this.client.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    }
  }

  /** Force-close the server-side socket to simulate a connection drop. */
  dropClient(): void {
    if (this.client) {
      this.client.terminate();
      this.client = null;
    }
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

function autoReplyJoin(server: MockPhoenixServer): void {
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
}

describe("PhoenixChannel didSpec", () => {
  let server: MockPhoenixServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("sends custom didSpec in join payload", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();

    const customSpec: DidSpec = {
      mode: "Require",
      storage: "persistent",
      label: "my-openclaw-agent",
      type: "plugin",
      verificationMethods: [
        { purpose: "authentication" },
        { purpose: "keyAgreement" },
      ],
    };

    const joinPayloadReceived = new Promise<unknown>((resolve) => {
      server.onMsg = (msg) => {
        if (msg.event === "phx_join") {
          resolve(msg.payload);
          server.sendToClient(
            msg.ref,
            msg.ref,
            msg.topic,
            "phx_reply",
            { status: "ok", response: { did: "did:web:node:test" } },
          );
        }
      };
    });

    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
    }, customSpec);

    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    const payload = await joinPayloadReceived as {
      did_spec: DidSpec;
      payload_types: string[];
    };

    expect(payload.did_spec.mode).toBe("Require");
    expect(payload.did_spec.storage).toBe("persistent");
    expect(payload.did_spec.label).toBe("my-openclaw-agent");
    expect(payload.did_spec.verificationMethods).toHaveLength(2);

    ch.close();
  });

  it("uses default didSpec when none provided", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();

    const joinPayloadReceived = new Promise<unknown>((resolve) => {
      server.onMsg = (msg) => {
        if (msg.event === "phx_join") {
          resolve(msg.payload);
          server.sendToClient(
            msg.ref,
            msg.ref,
            msg.topic,
            "phx_reply",
            { status: "ok", response: { did: "did:web:node:test" } },
          );
        }
      };
    });

    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
    });

    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    const payload = await joinPayloadReceived as {
      did_spec: { mode: string; storage: string };
    };

    // Should still use the old defaults
    expect(payload.did_spec.mode).toBe("Create");
    expect(payload.did_spec.storage).toBe("ephemeral");

    ch.close();
  });
});

describe("PhoenixChannel capability negotiation", () => {
  let server: MockPhoenixServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("sends reply_protocol: true in join params", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();

    const joinPayloadReceived = new Promise<unknown>((resolve) => {
      server.onMsg = (msg) => {
        if (msg.event === "phx_join") {
          resolve(msg.payload);
          server.sendToClient(
            msg.ref, msg.ref, msg.topic, "phx_reply",
            { status: "ok", response: { did: "did:web:node:test" } },
          );
        }
      };
    });

    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
    });
    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    const payload = await joinPayloadReceived as { reply_protocol: boolean };
    expect(payload.reply_protocol).toBe(true);

    ch.close();
  });

  it("reports new mode when server returns reply_protocol/1 capability", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(
          msg.ref, msg.ref, msg.topic, "phx_reply",
          {
            status: "ok",
            response: {
              did: "did:web:node:test",
              capabilities: ["reply_protocol/1"],
            },
          },
        );
      }
    };

    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
    });
    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    expect(ch.replyProtocol()).toBe(true);
    ch.close();
  });

  it("reports legacy mode when server omits capabilities", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();

    server.onMsg = (msg) => {
      if (msg.event === "phx_join") {
        server.sendToClient(
          msg.ref, msg.ref, msg.topic, "phx_reply",
          { status: "ok", response: { did: "did:web:node:test" } },
        );
      }
    };

    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
    });
    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    expect(ch.replyProtocol()).toBe(false);
    ch.close();
  });
});

describe("PhoenixChannel reconnect", () => {
  let server: MockPhoenixServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("reconnects after connection drop", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();
    autoReplyJoin(server);

    let disconnected = false;
    let reconnected = false;
    let channel: PhoenixChannel | null = null;

    const reconnectedPromise = new Promise<void>((resolve) => {
      const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
        onMessage: () => {},
        onDisconnect: () => { disconnected = true; },
        onReconnect: () => { reconnected = true; resolve(); },
      });
      channel = ch;

      ch.connect(["https://layr8.io/protocols/echo/1.0"]).then(() => {
        // Connection established, now drop it
        server.dropClient();
      });
    });

    // Wait for reconnect (backoff starts at 1s)
    await reconnectedPromise;

    expect(disconnected).toBe(true);
    expect(reconnected).toBe(true);

    // Clean up the channel so afterEach can close the server
    channel!.close();
  }, 10_000);

  it("send() throws NotConnectedError during reconnect", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();
    autoReplyJoin(server);

    const disconnectedPromise = new Promise<PhoenixChannel>((resolve) => {
      const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
        onMessage: () => {},
        onDisconnect: () => { resolve(ch); },
      });

      ch.connect(["https://layr8.io/protocols/echo/1.0"]).then(() => {
        server.dropClient();
      });
    });

    const ch = await disconnectedPromise;
    // Small delay to ensure reconnect loop has started
    await delay(100);

    // send() should throw NotConnectedError while reconnecting
    await expect(ch.send("message", { body: "test" })).rejects.toThrow(NotConnectedError);

    // sendFireAndForget should also throw
    expect(() => ch.sendFireAndForget("message", { body: "test" })).toThrow(NotConnectedError);

    ch.close();
  }, 10_000);

  it("close() stops the reconnect loop", async () => {
    server = new MockPhoenixServer();
    const wsUrl = await server.ready();
    autoReplyJoin(server);

    let reconnected = false;
    const ch = new PhoenixChannel(wsUrl, "test-api-key", "did:web:test", {
      onMessage: () => {},
      onDisconnect: () => {},
      onReconnect: () => { reconnected = true; },
    });

    await ch.connect(["https://layr8.io/protocols/echo/1.0"]);

    // Drop and immediately close
    server.dropClient();
    await delay(100);
    ch.close();

    // Wait longer than the first backoff delay (1s) to confirm no reconnect
    await delay(2000);

    expect(reconnected).toBe(false);
  }, 10_000);
});
