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

/** A server that accepts the request and never answers it. */
async function silentServer(opts?: { partialHeaders?: boolean }): Promise<{
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
    if (opts?.partialHeaders) {
      // Answer just enough to look alive, then stop: status line, headers and
      // the opening brace of a body that never arrives.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"credentials":');
    }
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

/**
 * A server that answers every request, after `delayMs`, and counts the TCP
 * connections it was asked to accept.
 */
async function slowServer(delayMs: number): Promise<{
  url: string;
  /** TCP connections accepted — 1 across several requests means keep-alive reuse. */
  connections: () => number;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let connections = 0;
  let requests = 0;
  const timers: NodeJS.Timeout[] = [];

  const server = createServer((_req, res) => {
    requests += 1;
    timers.push(
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, delayMs),
    );
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    requests: () => requests,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      // Keep-alive means the client still holds an idle connection; `close`
      // alone would wait for it.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("a request deadline", () => {
  // `http.request` has NO default timeout. A peer that completes the TCP
  // handshake and then says nothing leaves the promise pending forever — and on
  // the credential read that precedes a send, "forever" is the whole channel,
  // because that read runs inside the per-channel write chain.

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

describe("the client-wide default deadline", () => {
  // Before this existed, only `Wallet.read` passed a `timeoutMs`. Every other
  // REST call — sign, verify, store, list, get — waited forever on a node that
  // accepted the connection and went quiet: no result, no error, and no moment
  // at which the caller could decide to retry.

  it("bounds a post() that was given no options at all", async () => {
    // The core of this change: `post` did not even ACCEPT a deadline before,
    // so this call is the one that used to hang forever.
    const s = await silentServer();
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(
      client.post("/api/v1/credentials/sign", { credential: {} }),
    ).rejects.toThrow(/timed out after 60ms/);
    await expect(s.clientGaveUp).resolves.toBeUndefined();

    await s.close();
  });

  it("bounds a get() that was given no options at all", async () => {
    const s = await silentServer();
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(client.get("/api/v1/credentials")).rejects.toThrow(
      /timed out after 60ms/,
    );
    await expect(s.clientGaveUp).resolves.toBeUndefined();

    await s.close();
  });

  it("cuts off a peer that goes quiet AFTER the headers, not just before", async () => {
    // The deadline is on socket inactivity, not on getting a response object.
    // A node that sends a status line and then stalls mid-body is just as stuck
    // as one that never answered, and reads as success to anything watching
    // only for headers.
    const s = await silentServer({ partialHeaders: true });
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(client.get("/api/v1/credentials")).rejects.toThrow(
      /timed out after 60ms/,
    );
    await expect(s.clientGaveUp).resolves.toBeUndefined();

    await s.close();
  });

  it("is overridden by a shorter per-call deadline", async () => {
    const s = await silentServer();
    const client = new RestClient(s.url, "test-api-key", 30_000);

    await expect(
      client.post("/api/v1/credentials/sign", {}, { timeoutMs: 60 }),
    ).rejects.toThrow(/timed out after 60ms/);

    await s.close();
  });

  it("is overridden by a LONGER per-call deadline — the escape hatch signing needs", async () => {
    // Signing happens with no bytes on the wire, so a slow sign is silence to
    // this deadline. If the per-call value did not really win, this call would
    // die at 60ms instead of returning at ~200ms.
    const s = await slowServer(200);
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(
      client.post("/api/v1/credentials/sign", {}, { timeoutMs: 5_000 }),
    ).resolves.toEqual({ ok: true });

    await s.close();
  });

  it("is turned off entirely by an explicit timeoutMs of 0", async () => {
    // `0` is not "no value given" — `??` keeps the two apart, where `||` would
    // have turned the one way to opt out back into the default.
    const s = await slowServer(200);
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(
      client.post("/api/v1/credentials/sign", {}, { timeoutMs: 0 }),
    ).resolves.toEqual({ ok: true });

    await s.close();
  });

  it("also accepts 0 as the client-wide default", async () => {
    const s = await slowServer(200);
    const client = new RestClient(s.url, "test-api-key", 0);

    await expect(client.get("/api/v1/credentials")).resolves.toEqual({ ok: true });

    await s.close();
  });

  it("leaves no timer armed on a pooled connection, across repeated calls", async () => {
    // `req.setTimeout` arms the SOCKET, and Node's global agent keeps sockets
    // alive between requests. A deadline left behind on a socket returned to
    // that pool would kill a LATER, healthy request — or the idle connection
    // between two of them. Node clears the per-request callback when the
    // response ends; this asserts it rather than trusting it.
    const s = await slowServer(0);
    const client = new RestClient(s.url, "test-api-key", 80);

    for (let i = 0; i < 3; i++) {
      await expect(client.get(`/api/v1/credentials?n=${i}`)).resolves.toEqual({
        ok: true,
      });
      // Idle for longer than the deadline. A leftover timer fires HERE.
      await new Promise<void>((r) => setTimeout(r, 120));
    }

    // The whole test is vacuous unless the connection really was reused: three
    // requests over one TCP connection is what puts a stale timer in reach.
    expect(s.requests()).toBe(3);
    expect(s.connections()).toBe(1);

    await s.close();
  });
});
