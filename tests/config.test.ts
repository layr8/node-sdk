import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses provided values", () => {
    const cfg = resolveConfig({
      nodeUrl: "ws://localhost:4000",
      apiKey: "my-key",
      agentDid: "did:web:test",
    });
    expect(cfg.nodeUrl).toBe("ws://localhost:4000");
    expect(cfg.apiKey).toBe("my-key");
    expect(cfg.agentDid).toBe("did:web:test");
  });

  it("falls back to environment variables", () => {
    process.env.LAYR8_NODE_URL = "ws://env-node:4000";
    process.env.LAYR8_API_KEY = "env-key";
    process.env.LAYR8_AGENT_DID = "did:web:env";

    const cfg = resolveConfig({});
    expect(cfg.nodeUrl).toBe("ws://env-node:4000");
    expect(cfg.apiKey).toBe("env-key");
    expect(cfg.agentDid).toBe("did:web:env");
  });

  it("throws when nodeUrl is missing", () => {
    expect(() => resolveConfig({ apiKey: "key" })).toThrow(
      /nodeUrl is required/,
    );
  });

  it("throws when apiKey is missing", () => {
    expect(() =>
      resolveConfig({ nodeUrl: "ws://localhost:4000" }),
    ).toThrow(/apiKey is required/);
  });

  it("normalizes https:// to wss://", () => {
    const cfg = resolveConfig({
      nodeUrl: "https://mynode.layr8.cloud/plugin_socket/websocket",
      apiKey: "key",
    });
    expect(cfg.nodeUrl).toBe(
      "wss://mynode.layr8.cloud/plugin_socket/websocket",
    );
  });

  it("normalizes http:// to ws://", () => {
    const cfg = resolveConfig({
      nodeUrl: "http://localhost:4000/plugin_socket/websocket",
      apiKey: "key",
    });
    expect(cfg.nodeUrl).toBe(
      "ws://localhost:4000/plugin_socket/websocket",
    );
  });

  it("allows empty agentDid", () => {
    const cfg = resolveConfig({
      nodeUrl: "ws://localhost:4000",
      apiKey: "key",
    });
    expect(cfg.agentDid).toBe("");
  });
});
