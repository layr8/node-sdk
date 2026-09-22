import { describe, it, expect } from "vitest";
import { ConnectionError, redactUrl } from "../src/errors.js";

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
