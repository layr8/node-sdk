import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ConnectionError, redactUrl, redactUrlsInText } from "../src/errors.js";
import { Connection } from "../src/connection.js";

// The cloud-node URL carries the agent's API key as `?api_key=…`. An error
// carrying that URL unredacted puts a live credential wherever the error goes:
// a broker log, a crash report, a session transcript someone later shares. That
// is how a key leaked on 2026-09-22.

const KEY = "brkmyspacelaptop_" + "A".repeat(24);
const NODE_URL = `wss://myspace.example.com/plugin_socket/websocket?api_key=${KEY}&vsn=2.0.0`;

describe("redactUrl", () => {
  it("removes the api_key but keeps everything diagnostic", () => {
    const out = redactUrl(NODE_URL);
    expect(out).not.toContain(KEY);
    expect(out).toContain("wss://myspace.example.com");
    expect(out).toContain("/plugin_socket/websocket");
    expect(out).toContain("vsn=2.0.0"); // unrelated params must survive
    expect(out).toContain("api_key=REDACTED"); // the NAME stays, so the reader knows what went
  });

  it("covers the other credential parameter names", () => {
    for (const name of [
      "api_key",
      "apiKey",
      "api-key",
      "access_token",
      "auth_token",
      "token",
      "secret",
      "password",
    ]) {
      const out = redactUrl(`wss://h/p?${name}=s3cr3tvalue`);
      expect(out, `${name} survived`).not.toContain("s3cr3tvalue");
    }
  });

  it("redacts userinfo credentials too", () => {
    const out = redactUrl("wss://user:hunter2@h/p");
    expect(out).not.toContain("hunter2");
  });

  it("leaves a clean url byte-for-byte alone", () => {
    const clean = "wss://myspace.example.com/plugin_socket/websocket?vsn=2.0.0";
    expect(redactUrl(clean)).toBe(clean);
  });

  it("refuses to pass through what it cannot parse", () => {
    // If it cannot parse the URL it cannot promise the key is gone, so it must
    // not hand the original back.
    expect(redactUrl("not a url at all")).toBe("<unparseable url>");
    expect(redactUrl(`::::?api_key=${KEY}`)).not.toContain(KEY);
  });
});

describe("ConnectionError", () => {
  it("keeps the key out of the message", () => {
    const err = new ConnectionError(NODE_URL, "ECONNREFUSED");
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("keeps the key out of the .url property", () => {
    // Callers log `err.url` as readily as `err.message`; redacting only the
    // message would leak straight through the property.
    const err = new ConnectionError(NODE_URL, "ECONNREFUSED");
    expect(err.url).not.toContain(KEY);
  });

  it("does not leak through serialization", () => {
    const err = new ConnectionError(NODE_URL, "ECONNREFUSED");
    const serialized = JSON.stringify({
      message: err.message,
      url: err.url,
      reason: err.reason,
      stack: err.stack,
    });
    expect(serialized).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
// The reason, not only the url
// ---------------------------------------------------------------------------
//
// #88 redacted the `url` argument. But the SDK passes its own `wsUrl` there,
// which never carries the key; the key is added only to the URL handed to the
// WebSocket. What leaked (measured 2026-09-28 from a Bun-compiled launcher) was
// the runtime's own error message, passed through as `reason`:
//
//   connection error [wss://h/plugin_socket/websocket]: WebSocket connection to
//   'wss://h/plugin_socket/websocket?api_key=<key>&vsn=2.0.0' failed: Failed to connect

const BUN_REASON = `WebSocket connection to '${NODE_URL}' failed: Failed to connect`;

describe("redactUrlsInText", () => {
  it("redacts a quoted URL inside prose and keeps the prose", () => {
    const out = redactUrlsInText(BUN_REASON);
    expect(out).not.toContain(KEY);
    expect(out).toBe(
      "WebSocket connection to 'wss://myspace.example.com/plugin_socket/websocket?api_key=REDACTED&vsn=2.0.0' failed: Failed to connect",
    );
  });

  it("handles unquoted, double-quoted, bracketed and punctuation-terminated URLs", () => {
    for (const text of [
      `dial ${NODE_URL} failed`,
      `dial "${NODE_URL}" failed`,
      `dial (${NODE_URL}) failed`,
      `dial <${NODE_URL}> failed`,
      `could not reach ${NODE_URL}.`,
      `could not reach ${NODE_URL}, retrying`,
      `wss://h/p?vsn=2.0.0&api_key=${KEY}`,
    ]) {
      const out = redactUrlsInText(text);
      expect(out, text).not.toContain(KEY);
      expect(out, text).toContain("api_key=REDACTED");
    }
  });

  it("keeps sentence punctuation outside the URL", () => {
    expect(redactUrlsInText(`could not reach wss://h/p?api_key=${KEY}.`)).toBe(
      "could not reach wss://h/p?api_key=REDACTED.",
    );
  });

  it("redacts userinfo passwords in embedded URLs", () => {
    const out = redactUrlsInText("dial 'wss://user:hunter2@h/p' failed");
    expect(out).not.toContain("hunter2");
  });

  it("redacts a credential pair with no URL around it", () => {
    for (const text of [
      `request ?api_key=${KEY}&vsn=2.0.0 rejected`,
      `/plugin_socket/websocket?token=${KEY}`,
      `api_key=${KEY}`,
    ]) {
      expect(redactUrlsInText(text), text).not.toContain(KEY);
    }
  });

  it("leaves text without credentials byte-for-byte alone", () => {
    for (const text of [
      "connect ECONNREFUSED 127.0.0.1:1",
      "getaddrinfo ENOTFOUND myspace.node.invalid",
      "Unexpected server response: 403",
      "join rejected: error",
      "WebSocket connection to 'wss://h/plugin_socket/websocket?vsn=2.0.0' failed",
    ]) {
      expect(redactUrlsInText(text)).toBe(text);
    }
  });
});

describe("ConnectionError reason", () => {
  // The exact shape of the call site in src/connection.ts: our own key-free
  // wsUrl as `url`, the runtime's message as `reason`.
  const KEYLESS_URL = "wss://myspace.example.com/plugin_socket/websocket";

  it("keeps the key out of message, reason and url", () => {
    const err = new ConnectionError(KEYLESS_URL, BUN_REASON);
    expect(err.message).not.toContain(KEY);
    expect(err.reason).not.toContain(KEY);
    expect(err.url).not.toContain(KEY);
    expect(err.stack ?? "").not.toContain(KEY);
    // Still diagnostic: which host, and what the runtime said.
    expect(err.message).toContain("myspace.example.com");
    expect(err.reason).toContain("Failed to connect");
  });

  it("covers the synthetic case from the work order", () => {
    const err = new ConnectionError("wss://h/p", "wss://h/p?api_key=SECRET&vsn=2.0.0");
    expect(err.message).not.toContain("SECRET");
    expect(err.reason).not.toContain("SECRET");
    expect(err.url).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Real dial failures through src/connection.ts
// ---------------------------------------------------------------------------

/** An HTTP server that refuses every WebSocket upgrade with 403. */
async function refusingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(403);
    res.end("forbidden");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/plugin_socket/websocket`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A URL on a port that was free a moment ago and is now closed. */
async function closedPortUrl(): Promise<string> {
  const s = await refusingServer();
  await s.close();
  return s.url;
}

describe("a real dial failure under Node (ws package)", () => {
  // Under Node the `ws` package's dial errors do not quote the URL
  // (`connect ECONNREFUSED …`, `Unexpected server response: 403`), so this does
  // not reproduce the leak; it guards against that changing.
  it("rejected upgrade: no key anywhere in the error", async () => {
    const srv = await refusingServer();
    try {
      const conn = new Connection(srv.url, KEY);
      const err = (await conn.dial().then(
        () => null,
        (e: unknown) => e,
      )) as ConnectionError;
      conn.close();
      expect(err).toBeInstanceOf(ConnectionError);
      expect(JSON.stringify({ m: err.message, r: err.reason, u: err.url, s: err.stack })).not.toContain(KEY);
    } finally {
      await srv.close();
    }
  });

  it("refused connection: no key anywhere in the error", async () => {
    const conn = new Connection(await closedPortUrl(), KEY);
    const err = (await conn.dial().then(
      () => null,
      (e: unknown) => e,
    )) as ConnectionError;
    conn.close();
    expect(err).toBeInstanceOf(ConnectionError);
    expect(JSON.stringify({ m: err.message, r: err.reason, u: err.url, s: err.stack })).not.toContain(KEY);
  });
});

// Bun is where the leak was measured: the launcher is a `bun build --compile`
// binary, and Bun's WebSocket quotes the full dialed URL in its error. Node
// cannot produce that message, so the dial runs in a Bun child process.
//
// CI installs Bun for this. Skipping silently in CI would turn the one test
// that reproduces the leak into a green nothing, so there it fails instead.
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const HAVE_BUN = bun.status === 0;
const FIXTURE = fileURLToPath(new URL("./fixtures/dial-and-report.ts", import.meta.url));

describe("a real dial failure under Bun", () => {
  it("Bun is available where it must be", () => {
    if (process.env.CI) expect(HAVE_BUN, "Bun is required in CI for the Bun dial tests").toBe(true);
  });

  async function dialUnderBun(url: string): Promise<Record<string, string | boolean | undefined>> {
    const r = spawnSync("bun", [FIXTURE, url, KEY], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").pop()!);
  }

  // The server must answer while the child runs, so spawn asynchronously here.
  async function dialUnderBunAsync(url: string): Promise<Record<string, string | boolean | undefined>> {
    const child = spawn("bun", [FIXTURE, url, KEY]);
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code, errOut).toBe(0);
    return JSON.parse(out.trim().split("\n").pop()!);
  }

  it.skipIf(!HAVE_BUN)("rejected upgrade: no key in message, reason, url or stack", async () => {
    const srv = await refusingServer();
    try {
      const r = await dialUnderBunAsync(srv.url);
      expect(r.dialed).toBe(false);
      expect(r.name).toBe("ConnectionError");
      // Positive control: the runtime message that used to carry the key is
      // still there, so this is the path that leaked, not some other error.
      expect(String(r.reason)).toContain("WebSocket connection to");
      expect(String(r.reason)).toContain("api_key=REDACTED");
      expect(JSON.stringify(r)).not.toContain(KEY);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it.skipIf(!HAVE_BUN)("refused connection: no key in message, reason, url or stack", async () => {
    const r = await dialUnderBun(await closedPortUrl());
    expect(r.dialed).toBe(false);
    expect(r.name).toBe("ConnectionError");
    expect(String(r.reason)).toContain("WebSocket connection to");
    expect(JSON.stringify(r)).not.toContain(KEY);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The disconnect event
// ---------------------------------------------------------------------------

describe("the error handed to disconnect listeners", () => {
  it("is redacted when the runtime's socket error quotes the keyed URL", () => {
    const seen: Error[] = [];
    const conn = new Connection("wss://myspace.example.com/plugin_socket/websocket", KEY, {
      onDisconnect: (e) => seen.push(e),
    });
    // Reach the private handler directly: no runtime this suite can drive
    // emits a keyed message after open, but a listener must be safe if one does.
    (conn as unknown as { onUnexpectedDisconnect(e: Error): void }).onUnexpectedDisconnect(
      new Error(BUN_REASON),
    );
    conn.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).not.toContain(KEY);
    expect(seen[0]!.stack ?? "").not.toContain(KEY);
  });

  it("passes a credential-free error through unchanged", () => {
    const seen: Error[] = [];
    const conn = new Connection("wss://myspace.example.com/plugin_socket/websocket", KEY, {
      onDisconnect: (e) => seen.push(e),
    });
    const original = new Error("WebSocket closed");
    (conn as unknown as { onUnexpectedDisconnect(e: Error): void }).onUnexpectedDisconnect(original);
    conn.close();
    expect(seen[0]).toBe(original);
  });
});
