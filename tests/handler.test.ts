import { describe, it, expect } from "vitest";
import { HandlerRegistry } from "../src/handler.js";

describe("HandlerRegistry", () => {
  it("registers and looks up a handler", () => {
    const registry = new HandlerRegistry();
    const fn = async () => null;
    registry.register("https://layr8.io/protocols/echo/1.0/request", fn);

    const entry = registry.lookup("https://layr8.io/protocols/echo/1.0/request");
    expect(entry).toBeDefined();
    expect(entry!.fn).toBe(fn);
    expect(entry!.manualAck).toBe(false);
  });

  it("registers with manualAck option", () => {
    const registry = new HandlerRegistry();
    registry.register(
      "https://layr8.io/protocols/echo/1.0/request",
      async () => null,
      { manualAck: true },
    );

    const entry = registry.lookup("https://layr8.io/protocols/echo/1.0/request");
    expect(entry!.manualAck).toBe(true);
  });

  it("returns undefined for unregistered type", () => {
    const registry = new HandlerRegistry();
    expect(registry.lookup("unknown-type")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const registry = new HandlerRegistry();
    registry.register("https://layr8.io/protocols/echo/1.0/request", async () => null);
    expect(() =>
      registry.register("https://layr8.io/protocols/echo/1.0/request", async () => null),
    ).toThrow(/already registered/);
  });

  it("derives unique protocols from handler types", () => {
    const registry = new HandlerRegistry();
    registry.register("https://layr8.io/protocols/echo/1.0/request", async () => null);
    registry.register("https://layr8.io/protocols/echo/1.0/response", async () => null);
    registry.register("https://didcomm.org/basicmessage/2.0/message", async () => null);

    const protocols = registry.protocols();
    expect(protocols).toHaveLength(2);
    expect(protocols).toContain("https://layr8.io/protocols/echo/1.0");
    expect(protocols).toContain("https://didcomm.org/basicmessage/2.0");
  });
});
