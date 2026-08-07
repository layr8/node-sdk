import { describe, it, expect, vi, afterEach } from "vitest";
import { ClientRequest, createServer, type ServerResponse } from "node:http";
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
    // have turned the one way to opt out back into the default. Discriminating
    // because the client default here (60ms) is SHORTER than the server's
    // 200ms: if `0` did not disable the deadline, this call would be cut off.
    const s = await slowServer(200);
    const client = new RestClient(s.url, "test-api-key", 60);

    await expect(
      client.post("/api/v1/credentials/sign", {}, { timeoutMs: 0 }),
    ).resolves.toEqual({ ok: true });

    await s.close();
  });

  it("still completes a normal call when the client default is 0", async () => {
    // What this pins is only that a client-wide `0` does not BREAK a request.
    // It cannot tell `0` apart from the 30s default — both let a 200ms call
    // through, and no black-box test can separate them without waiting 30
    // seconds. The test that actually holds that line is in "which deadline the
    // client arms" below.
    const s = await slowServer(200);
    const client = new RestClient(s.url, "test-api-key", 0);

    await expect(client.get("/api/v1/credentials")).resolves.toEqual({ ok: true });

    await s.close();
  });

  it("survives repeated calls over one pooled connection", async () => {
    // `req.setTimeout` arms the SOCKET, and Node's global agent keeps sockets
    // alive between requests, so the obvious worry is a deadline outliving its
    // request and killing a later, healthy one.
    //
    // This is a characterization test for that arrangement — three calls and
    // two idle gaps longer than the deadline, over a single TCP connection, all
    // succeeding. It does NOT detect a leaked timer: a callback left behind
    // would call `destroy` on a request that has already settled, which changes
    // nothing observable here. The reasoning about why Node leaves nothing of
    // ours on the socket, and the measurement behind it, is in `src/rest.ts`.
    const s = await slowServer(0);
    const client = new RestClient(s.url, "test-api-key", 80);

    for (let i = 0; i < 3; i++) {
      await expect(client.get(`/api/v1/credentials?n=${i}`)).resolves.toEqual({
        ok: true,
      });
      // Idle for longer than the deadline, which is when a socket the agent had
      // left armed at OUR value would be torn down under us.
      await new Promise<void>((r) => setTimeout(r, 120));
    }

    // The arrangement under test is connection REUSE — without this the three
    // calls are three unrelated connections and the test says nothing at all.
    expect(s.requests()).toBe(3);
    expect(s.connections()).toBe(1);

    await s.close();
  });
});

describe("which deadline the client arms", () => {
  // The gap this closes: `restTimeoutMs: 0` and the 30s default are
  // indistinguishable from the outside for the first 30 seconds, so every
  // black-box test above passes whether or not a client-wide `0` is honoured.
  // A mutation that quietly rewrote `0` to the default (`defaultTimeoutMs ||
  // DEFAULT_REST_TIMEOUT_MS`) left the entire suite green.
  //
  // So assert the DECISION rather than its consequence: whether a socket
  // deadline was armed at all, and with what value. `0` disabling the deadline
  // is a documented escape hatch in both the README and the CHANGELOG, and this
  // is what holds callers to it.

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The deadlines `run` actually armed on the socket, in order. */
  async function armed(
    defaultTimeoutMs: number,
    run: (client: RestClient) => Promise<unknown>,
  ): Promise<number[]> {
    const s = await slowServer(0);
    const spy = vi.spyOn(ClientRequest.prototype, "setTimeout");
    const client = new RestClient(s.url, "test-api-key", defaultTimeoutMs);

    await run(client);

    const values = spy.mock.calls.map((call) => call[0]);
    await s.close();
    return values;
  }

  it("arms the client default when the call brings none", async () => {
    expect(await armed(60, (c) => c.get("/api/v1/credentials"))).toEqual([60]);
    expect(await armed(60, (c) => c.post("/api/v1/credentials/sign", {}))).toEqual([60]);
  });

  it("arms NOTHING when the client default is 0", async () => {
    expect(await armed(0, (c) => c.get("/api/v1/credentials"))).toEqual([]);
    expect(await armed(0, (c) => c.post("/api/v1/credentials/sign", {}))).toEqual([]);
  });

  it("arms NOTHING when the call passes 0, whatever the client default", async () => {
    expect(
      await armed(60, (c) => c.get("/api/v1/credentials", { timeoutMs: 0 })),
    ).toEqual([]);
  });

  it("arms the per-call value when the call brings one", async () => {
    expect(
      await armed(60, (c) => c.get("/api/v1/credentials", { timeoutMs: 5_000 })),
    ).toEqual([5_000]);
  });
});
