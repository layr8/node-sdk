import { describe, it, expect } from "vitest";
import { Layr8Client, logErrors } from "../src/index.js";

// The reading existed on `Channel` from the day the feature shipped, and
// `Channel` is not exported. `Layr8Client` — the entry every README example
// uses — had no way to reach it, while the Go, Python and Elixir SDKs all
// expose it on their client. This pins the parity.
describe("Layr8Client exposes the delegation reading", () => {
  const client = () =>
    new Layr8Client(logErrors(), {
      nodeUrl: "wss://node.example/plugin_socket/websocket",
      apiKey: "k",
    });

  it("has both halves of the reading, not just the credentials", () => {
    const c = client();
    expect(typeof c.delegatedCredentials).toBe("function");
    expect(typeof c.supportsEphemeralDelegation).toBe("function");
  });

  it("before connect, says nothing looked rather than nothing was found", () => {
    const c = client();

    // These two together are the third state. `undefined` alone would say
    // "the parent holds nothing", which nobody measured.
    expect(c.delegatedCredentials()).toBeUndefined();
    expect(c.supportsEphemeralDelegation()).toBe(false);
  });
});
