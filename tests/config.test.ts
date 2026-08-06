import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig, DEFAULT_DID_SPEC, DEFAULT_GRANT_CACHE_MS } from "../src/config.js";
import type { DidSpec } from "../src/config.js";

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

  it("uses default didSpec when none provided", () => {
    const cfg = resolveConfig({
      nodeUrl: "ws://localhost:4000",
      apiKey: "key",
    });
    expect(cfg.didSpec).toEqual(DEFAULT_DID_SPEC);
  });

  it("passes through custom didSpec", () => {
    const custom: DidSpec = {
      mode: "Require",
      storage: "persistent",
      label: "my-agent",
      type: "plugin",
      controller: "",
      verificationMethods: [
        { purpose: "authentication" },
      ],
    };
    const cfg = resolveConfig({
      nodeUrl: "ws://localhost:4000",
      apiKey: "key",
      didSpec: custom,
    });
    expect(cfg.didSpec).toEqual(custom);
  });

  it("merges partial didSpec with defaults", () => {
    const cfg = resolveConfig({
      nodeUrl: "ws://localhost:4000",
      apiKey: "key",
      didSpec: {
        mode: "Require",
        storage: "persistent",
        label: "my-agent",
      },
    });
    expect(cfg.didSpec.mode).toBe("Require");
    expect(cfg.didSpec.storage).toBe("persistent");
    expect(cfg.didSpec.label).toBe("my-agent");
    // Defaults filled in
    expect(cfg.didSpec.type).toBe("plugin");
    expect(cfg.didSpec.verificationMethods).toEqual(
      DEFAULT_DID_SPEC.verificationMethods,
    );
  });
});

describe("grant attachment options", () => {
  const originalEnv = { ...process.env };
  const base = { nodeUrl: "ws://localhost:4000", apiKey: "test-api-key" };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("attaches grants by default", () => {
    expect(resolveConfig(base).attachGrants).toBe(true);
    expect(resolveConfig(base).grantCacheMs).toBe(DEFAULT_GRANT_CACHE_MS);
  });

  it("can be turned off from the environment, for a deployment nobody can rebuild", () => {
    // The same reason `nodeUrl` and `apiKey` have an env fallback. Without it,
    // the only way to stop attaching is a code change and a release.
    process.env.LAYR8_ATTACH_GRANTS = "false";
    expect(resolveConfig(base).attachGrants).toBe(false);

    process.env.LAYR8_ATTACH_GRANTS = "0";
    expect(resolveConfig(base).attachGrants).toBe(false);
  });

  it("lets explicit config win over the environment", () => {
    process.env.LAYR8_ATTACH_GRANTS = "false";
    expect(resolveConfig({ ...base, attachGrants: true }).attachGrants).toBe(true);
  });

  it("ignores an env value it does not understand rather than reading it as off", () => {
    // An exported-but-empty variable is the common case, and silently disabling
    // attachment produces exactly the denial this feature exists to prevent.
    process.env.LAYR8_ATTACH_GRANTS = "";
    expect(resolveConfig(base).attachGrants).toBe(true);

    process.env.LAYR8_ATTACH_GRANTS = "maybe";
    expect(resolveConfig(base).attachGrants).toBe(true);
  });

  it("takes the cache TTL from the environment, and ignores a typo", () => {
    process.env.LAYR8_GRANT_CACHE_MS = "5000";
    expect(resolveConfig(base).grantCacheMs).toBe(5000);

    // `Number("30s")` is NaN, and every TTL comparison against NaN is false —
    // which would re-read the credentials on EVERY message.
    process.env.LAYR8_GRANT_CACHE_MS = "30s";
    expect(resolveConfig(base).grantCacheMs).toBe(DEFAULT_GRANT_CACHE_MS);
  });
});
