import { describe, it, expect } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { RestClient, restUrlFromWebSocket } from "../src/rest.js";

describe("restUrlFromWebSocket", () => {
  it("converts ws:// to http://", () => {
    expect(
      restUrlFromWebSocket("ws://alice-test.localhost:4000/plugin_socket/websocket"),
    ).toBe("http://alice-test.localhost:4000");
  });

  it("converts wss:// to https://", () => {
    expect(
      restUrlFromWebSocket("wss://alice-test.localhost/plugin_socket/websocket"),
    ).toBe("https://alice-test.localhost");
  });

  it("handles ws:// without path", () => {
    expect(restUrlFromWebSocket("ws://localhost:4000")).toBe(
      "http://localhost:4000",
    );
  });

  it("handles wss:// without path", () => {
    expect(restUrlFromWebSocket("wss://mynode.example.com")).toBe(
      "https://mynode.example.com",
    );
  });

  it("handles ws:// with port and path", () => {
    expect(
      restUrlFromWebSocket("ws://node.localhost:8080/some/path"),
    ).toBe("http://node.localhost:8080");
  });

  it("handles wss:// with standard port", () => {
    expect(
      restUrlFromWebSocket("wss://node.layr8.cloud:443/plugin_socket/websocket"),
    ).toBe("https://node.layr8.cloud");
  });

  it("strips query parameters", () => {
    expect(
      restUrlFromWebSocket("ws://localhost:4000/path?token=abc"),
    ).toBe("http://localhost:4000");
  });

  it("strips fragment", () => {
    expect(
      restUrlFromWebSocket("ws://localhost:4000/path#section"),
    ).toBe("http://localhost:4000");
  });
});

describe("a request deadline", () => {
  // `http.request` has NO default timeout. A peer that completes the TCP
  // handshake and then says nothing leaves the promise pending forever — and on
  // the credential read that precedes a send, "forever" is the whole channel,
  // because that read runs inside the per-channel write chain.

  /** A server that accepts the request and never answers it. */
  async function silentServer(): Promise<{
    url: string;
    /** Resolves when the server sees the client hang up. */
    clientGaveUp: Promise<void>;
    close: () => Promise<void>;
  }> {
    const parked: ServerResponse[] = [];
    let sawClose!: () => void;
    const clientGaveUp = new Promise<void>((r) => {
      sawClose = r;
    });

    const server = createServer((_req, res) => {
      parked.push(res);
      res.on("close", () => sawClose());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${port}`,
      clientGaveUp,
      close: async () => {
        for (const res of parked) res.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  it("rejects, naming the deadline, when the peer never answers", async () => {
    const s = await silentServer();
    const client = new RestClient(s.url, "test-api-key");

    await expect(client.get("/api/v1/credentials", { timeoutMs: 60 })).rejects.toThrow(
      /timed out after 60ms/,
    );

    await s.close();
  });

  it("DESTROYS the request, rather than just noticing the timeout", async () => {
    // `setTimeout` on its own only emits an event: the request stays open, the
    // socket stays held, and nothing settles. The server seeing the connection
    // go is the only evidence that distinguishes the two.
    const s = await silentServer();
    const client = new RestClient(s.url, "test-api-key");

    await client.get("/api/v1/credentials", { timeoutMs: 60 }).catch(() => {});
    await expect(s.clientGaveUp).resolves.toBeUndefined();

    await s.close();
  });
});
