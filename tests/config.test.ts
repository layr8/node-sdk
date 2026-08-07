import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveConfig,
  DEFAULT_DID_SPEC,
  DEFAULT_GRANT_CACHE_MS,
  DEFAULT_GRANT_READ_TIMEOUT_MS,
  DEFAULT_REST_TIMEOUT_MS,
} from "../src/config.js";
import type { Config, DidSpec, GrantMissInfo } from "../src/config.js";

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

  it("treats an exported-but-empty cache TTL as unset, not as zero", () => {
    // `Number("")` is 0, and 0 is a legitimate TTL meaning "never cache" — so
    // the old parse turned an exported-but-empty variable into a credential read
    // on EVERY message. Every other env setting here already treats empty as
    // unset; this one now agrees with them.
    process.env.LAYR8_GRANT_CACHE_MS = "";
    expect(resolveConfig(base).grantCacheMs).toBe(DEFAULT_GRANT_CACHE_MS);

    // Zero asked for EXPLICITLY still means what it says.
    expect(resolveConfig({ ...base, grantCacheMs: 0 }).grantCacheMs).toBe(0);
  });

  it("bounds the credential read, from config or the environment", () => {
    expect(resolveConfig(base).grantReadTimeoutMs).toBe(DEFAULT_GRANT_READ_TIMEOUT_MS);
    expect(resolveConfig({ ...base, grantReadTimeoutMs: 500 }).grantReadTimeoutMs).toBe(500);

    process.env.LAYR8_GRANT_READ_TIMEOUT_MS = "750";
    expect(resolveConfig(base).grantReadTimeoutMs).toBe(750);
  });

  it("ignores a zero or unreadable deadline instead of disabling the read", () => {
    // Unlike the cache TTL, where zero means "never cache", a zero deadline
    // would abort every read before it started — an agent that attaches
    // nothing, which is the exact failure this feature exists to end. A typo
    // must not be able to produce it.
    process.env.LAYR8_GRANT_READ_TIMEOUT_MS = "0";
    expect(resolveConfig(base).grantReadTimeoutMs).toBe(DEFAULT_GRANT_READ_TIMEOUT_MS);

    process.env.LAYR8_GRANT_READ_TIMEOUT_MS = "2s";
    expect(resolveConfig(base).grantReadTimeoutMs).toBe(DEFAULT_GRANT_READ_TIMEOUT_MS);

    // An exported-but-empty variable is "unset", as it is for the booleans.
    process.env.LAYR8_GRANT_READ_TIMEOUT_MS = "";
    expect(resolveConfig(base).grantReadTimeoutMs).toBe(DEFAULT_GRANT_READ_TIMEOUT_MS);
  });
});

describe("the REST deadline", () => {
  const originalEnv = { ...process.env };
  const base = { nodeUrl: "ws://localhost:4000", apiKey: "test-api-key" };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("bounds every REST call by default, from config or the environment", () => {
    expect(resolveConfig(base).restTimeoutMs).toBe(DEFAULT_REST_TIMEOUT_MS);
    expect(resolveConfig({ ...base, restTimeoutMs: 5_000 }).restTimeoutMs).toBe(5_000);

    process.env.LAYR8_REST_TIMEOUT_MS = "45000";
    expect(resolveConfig(base).restTimeoutMs).toBe(45_000);
  });

  it("accepts zero as 'no deadline', unlike the credential read", () => {
    // The contrast is the point. A zero grant-read deadline would abort the read
    // before it started and attach nothing; a zero REST deadline is just the
    // unbounded behaviour that shipped before, which an operator with a very
    // slow node is entitled to ask for.
    expect(resolveConfig({ ...base, restTimeoutMs: 0 }).restTimeoutMs).toBe(0);

    process.env.LAYR8_REST_TIMEOUT_MS = "0";
    expect(resolveConfig(base).restTimeoutMs).toBe(0);
  });

  it("ignores an unreadable or exported-but-empty value", () => {
    process.env.LAYR8_REST_TIMEOUT_MS = "30s";
    expect(resolveConfig(base).restTimeoutMs).toBe(DEFAULT_REST_TIMEOUT_MS);

    // `Number("")` is 0, and 0 means something here — so empty must be caught
    // as "unset" before it silently removes the deadline from every call.
    process.env.LAYR8_REST_TIMEOUT_MS = "";
    expect(resolveConfig(base).restTimeoutMs).toBe(DEFAULT_REST_TIMEOUT_MS);
  });
});

describe("what a caller can WRITE against", () => {
  // A compile-time claim, not a runtime one. `Config.onGrantMiss` was declared
  // without `denialCode` while the client passed it and the README's example
  // destructured it: the callback worked perfectly and the code copied out of
  // the README did not compile. Nothing caught it because `tsconfig.json`
  // excluded `tests`, and this file's own helpers were typed
  // `Record<string, unknown>`, which erases the check even when it runs.
  //
  // This test asserts almost nothing at runtime. Its job is to be TYPE-CHECKED —
  // `npm run lint` now covers `tests/`, so a field dropped from `GrantMissInfo`
  // fails the build here.
  it("sees every field the client actually passes", () => {
    const seen: string[] = [];

    const cfg: Config = {
      nodeUrl: "ws://localhost:4000",
      apiKey: "test-api-key",
      agentDid: "did:web:example.com:agents:test",
      grantReadTimeoutMs: 2_000,
      // Exactly the README's example.
      onGrantMiss: ({ to, type, denialCode, error, capped }) => {
        seen.push(String(to), type, String(denialCode), String(error), String(capped?.covering));
      },
    };

    const info: GrantMissInfo = { to: ["did:web:example.com:agents:peer"], type: "x/1.0/y" };
    cfg.onGrantMiss?.(info);

    expect(seen).toHaveLength(5);
  });
});
