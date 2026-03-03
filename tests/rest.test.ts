import { describe, it, expect } from "vitest";
import { restUrlFromWebSocket } from "../src/rest.js";

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
