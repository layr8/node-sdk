import { describe, it, expect } from "vitest";
import { HandlerRegistry } from "../src/handler.js";
import { PASS } from "../src/index.js";

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

  it("registers catch-all handler via registerCatchAll", () => {
    const registry = new HandlerRegistry();
    const fn = async () => null;
    registry.registerCatchAll(fn);

    const entry = registry.lookup("https://any.org/protocol/1.0/anything");
    expect(entry).toBeDefined();
    expect(entry!.fn).toBe(fn);
  });

  it("specific handler takes priority over catch-all", () => {
    const registry = new HandlerRegistry();
    const specific = async () => null;
    const catchAll = async () => null;
    registry.register("https://layr8.io/protocols/echo/1.0/request", specific);
    registry.registerCatchAll(catchAll);

    const entry = registry.lookup("https://layr8.io/protocols/echo/1.0/request");
    expect(entry!.fn).toBe(specific);

    const fallback = registry.lookup("https://other.org/something/1.0/msg");
    expect(fallback!.fn).toBe(catchAll);
  });

  it("throws on duplicate catch-all registration", () => {
    const registry = new HandlerRegistry();
    registry.registerCatchAll(async () => null);
    expect(() => registry.registerCatchAll(async () => null)).toThrow(/catch-all.*already registered/);
  });

  it("includes * in protocols when catch-all is registered", () => {
    const registry = new HandlerRegistry();
    registry.register("https://layr8.io/protocols/echo/1.0/request", async () => null);
    registry.registerCatchAll(async () => null);

    const protocols = registry.protocols();
    expect(protocols).toContain("*");
    expect(protocols).toContain("https://layr8.io/protocols/echo/1.0");
  });

  it("hasCatchAll returns true when catch-all is registered", () => {
    const registry = new HandlerRegistry();
    expect(registry.hasCatchAll()).toBe(false);
    registry.registerCatchAll(async () => null);
    expect(registry.hasCatchAll()).toBe(true);
  });
});

describe("PASS sentinel", () => {
  it("is exported and is a unique symbol", () => {
    expect(typeof PASS).toBe("symbol");
  });

  it("is distinct from other symbols", () => {
    expect(PASS).not.toBe(Symbol("PASS"));
  });
});
