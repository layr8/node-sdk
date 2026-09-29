import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Connection } from "../src/connection.js";
import { listeningPort } from "./helpers/mock-ws-server.js";

// The API key goes to the node in the `x-api-key` request header and never in
// the URL. A URL is recorded by everything it passes through — the ingress
// access log recorded tens of thousands of `?api_key=` lines in a few hours —
// so a key in it is a key in somebody's log.
//
// Contract: layr8/contracts plugin-socket-auth.md. The node side of the same
// boundary is cloud-node's test/l8_server_web/endpoints/plugin/socket_api_key_test.exs.

const KEY = "brkmyspacelaptop_" + "K".repeat(8) + "_" + "k".repeat(24);

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
}

/** A WebSocket server that accepts every upgrade and records the request. */
async function recordingServer(): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (_ws, req) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
  });
  const port = await listeningPort(wss);
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

function assertKeyInHeaderOnly(s: Seen): void {
  expect(s.headers["x-api-key"]).toBe(KEY);
  expect(s.url).not.toContain(KEY);
  expect(s.url).not.toContain("api_key");
  // The Phoenix protocol version still rides the query; only the key moved.
  expect(s.url).toContain("vsn=2.0.0");
}

describe("the API key on the wire under Node (ws package)", () => {
  it("is sent as the x-api-key header and is absent from the URL", async () => {
    const srv = await recordingServer();
    try {
      const conn = new Connection(`ws://127.0.0.1:${srv.port}/plugin_socket/websocket`, KEY);
      await conn.dial();
      conn.close();
      expect(srv.seen).toHaveLength(1);
      assertKeyInHeaderOnly(srv.seen[0]!);
    } finally {
      await srv.close();
    }
  });

  it("keeps the Host rewrite for localhost alongside the key header", async () => {
    // `localhost` is rewritten to 127.0.0.1 with the original Host header; the
    // two header sources must not overwrite one another.
    const srv = await recordingServer();
    try {
      const conn = new Connection(`ws://localhost:${srv.port}/plugin_socket/websocket`, KEY);
      await conn.dial();
      conn.close();
      assertKeyInHeaderOnly(srv.seen[0]!);
      expect(srv.seen[0]!.headers.host).toBe(`localhost:${srv.port}`);
    } finally {
      await srv.close();
    }
  });
});

// The launcher is a `bun build --compile` binary, and under Bun `ws` resolves
// to Bun's own implementation, not the npm package. Whether that one sends the
// `headers` option is a property of Bun, so it is measured from a real Bun
// process against a real server — a Node test cannot answer it.
//
// CI installs Bun; there the Bun check must run rather than skip, or the one
// test that can catch a header silently dropped by Bun turns into a green
// nothing (tests/redact-connection-error.test.ts applies the same rule).
const HAVE_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const FIXTURE = fileURLToPath(new URL("./fixtures/dial-and-report.ts", import.meta.url));

describe("the API key on the wire under Bun", () => {
  it("Bun is available where it must be", () => {
    if (process.env.CI) expect(HAVE_BUN, "Bun is required in CI for the Bun dial tests").toBe(true);
  });

  it.skipIf(!HAVE_BUN)("is sent as the x-api-key header and is absent from the URL", async () => {
    const srv = await recordingServer();
    try {
      const child = spawn("bun", [FIXTURE, `ws://127.0.0.1:${srv.port}/plugin_socket/websocket`, KEY]);
      let out = "";
      let errOut = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errOut += d));
      const code = await new Promise<number | null>((r) => child.on("close", r));
      expect(code, errOut).toBe(0);
      expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ dialed: true });
      expect(srv.seen).toHaveLength(1);
      assertKeyInHeaderOnly(srv.seen[0]!);
    } finally {
      await srv.close();
    }
  }, 30_000);
});
