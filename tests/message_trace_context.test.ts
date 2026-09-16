// Contract: the DIDComm `trace_context` plaintext header. Parse keeps the
// value, marshal writes it, a malformed value never fails parsing, and only
// the two defined members are carried.
import { describe, it, expect } from "vitest";
import { marshalDIDComm, parseDIDComm, readTraceContext } from "../src/message.js";
import type { InternalMessage } from "../src/message.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";

function inbound(traceContext: unknown, present = true) {
  return {
    plaintext: {
      id: "m1",
      type: "https://layr8.io/protocols/echo/1.0/request",
      from: "did:web:bob",
      to: ["did:web:alice"],
      thid: "t1",
      body: {},
      ...(present ? { trace_context: traceContext } : {}),
    },
  };
}

describe("trace_context header", () => {
  it("parse keeps traceparent and tracestate", () => {
    const msg = parseDIDComm(inbound({ traceparent: TRACEPARENT, tracestate: "a=b" }));
    expect(msg.traceContext).toEqual({ traceparent: TRACEPARENT, tracestate: "a=b" });
  });

  it("marshal writes it as a top-level trace_context object", () => {
    const msg: InternalMessage = {
      id: "m2",
      type: "https://layr8.io/protocols/echo/1.0/request",
      from: "did:web:alice",
      to: ["did:web:bob"],
      threadId: "t1",
      parentThreadId: "",
      body: {},
      traceContext: { traceparent: TRACEPARENT },
    };
    const wire = JSON.parse(marshalDIDComm(msg));
    expect(wire.trace_context).toEqual({ traceparent: TRACEPARENT });
    expect(wire.thid).toBe("t1");
  });

  it("survives parse then marshal unchanged", () => {
    const tc = { traceparent: TRACEPARENT, tracestate: "vendor=value" };
    const wire = JSON.parse(marshalDIDComm(parseDIDComm(inbound(tc))));
    expect(wire.trace_context).toEqual(tc);
  });

  it("absent stays absent", () => {
    const msg = parseDIDComm(inbound(undefined, false));
    expect(msg.traceContext).toBeUndefined();
    expect("trace_context" in JSON.parse(marshalDIDComm(msg))).toBe(false);
  });

  it.each([
    ["a string", "00-abc"],
    ["null", null],
    ["an array", [TRACEPARENT]],
    ["a number", 7],
    ["an object without traceparent", { tracestate: "a=b" }],
    ["an object with a non-string traceparent", { traceparent: 1 }],
  ])("a malformed value (%s) does not fail parsing and is dropped", (_label, value) => {
    const msg = parseDIDComm(inbound(value));
    expect(msg.id).toBe("m1");
    expect(msg.traceContext).toBeUndefined();
    expect("trace_context" in JSON.parse(marshalDIDComm(msg))).toBe(false);
  });

  it("unknown members are not forwarded; a non-string tracestate is dropped", () => {
    const msg = parseDIDComm(inbound({ traceparent: TRACEPARENT, tracestate: 5, extra: "x" }));
    expect(msg.traceContext).toEqual({ traceparent: TRACEPARENT });
    expect(JSON.parse(marshalDIDComm(msg)).trace_context).toEqual({ traceparent: TRACEPARENT });
  });

  it("readTraceContext is the one reader", () => {
    expect(readTraceContext({ traceparent: TRACEPARENT })).toEqual({ traceparent: TRACEPARENT });
    expect(readTraceContext(undefined)).toBeUndefined();
  });
});
