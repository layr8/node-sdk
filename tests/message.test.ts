import { describe, it, expect } from "vitest";
import {
  marshalDIDComm,
  parseDIDComm,
  generateId,
  unmarshalBody,
  ack,
  createMessage,
} from "../src/message.js";
import type { InternalMessage } from "../src/message.js";

describe("generateId", () => {
  it("returns a non-empty string", () => {
    expect(generateId()).toBeTruthy();
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("marshalDIDComm", () => {
  it("serializes a message with all fields", () => {
    const msg: InternalMessage = {
      id: "msg-1",
      type: "https://layr8.io/protocols/echo/1.0/request",
      from: "did:web:alice",
      to: ["did:web:bob"],
      threadId: "thread-1",
      parentThreadId: "parent-1",
      body: { message: "hello" },
    };

    const json = JSON.parse(marshalDIDComm(msg));
    expect(json.id).toBe("msg-1");
    expect(json.type).toBe("https://layr8.io/protocols/echo/1.0/request");
    expect(json.from).toBe("did:web:alice");
    expect(json.to).toEqual(["did:web:bob"]);
    expect(json.thid).toBe("thread-1");
    expect(json.pthid).toBe("parent-1");
    expect(json.body.message).toBe("hello");
  });

  it("omits thid/pthid when empty", () => {
    const msg: InternalMessage = {
      id: "msg-1",
      type: "test",
      from: "did:web:alice",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: {},
    };

    const json = JSON.parse(marshalDIDComm(msg));
    expect(json.thid).toBeUndefined();
    expect(json.pthid).toBeUndefined();
  });
});

describe("parseDIDComm", () => {
  it("parses inbound envelope with context", () => {
    const data = {
      context: {
        recipient: "did:web:alice",
        authorized: true,
        sender_credentials: [
          { credential_subject: { id: "did:web:bob", name: "Bob" } },
        ],
      },
      plaintext: {
        id: "msg-1",
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: "did:web:bob",
        to: ["did:web:alice"],
        thid: "thread-1",
        body: { content: "hello" },
      },
    };

    const msg = parseDIDComm(data);
    expect(msg.id).toBe("msg-1");
    expect(msg.from).toBe("did:web:bob");
    expect(msg.threadId).toBe("thread-1");
    expect(msg.context).toBeDefined();
    expect(msg.context!.authorized).toBe(true);
    expect(msg.context!.senderCredentials[0].name).toBe("Bob");
  });

  it("parses inbound envelope without context", () => {
    const data = {
      plaintext: {
        id: "msg-1",
        type: "test",
        from: "did:web:bob",
        body: { key: "value" },
      },
    };

    const msg = parseDIDComm(data);
    expect(msg.id).toBe("msg-1");
    expect(msg.context).toBeUndefined();
  });
});

describe("unmarshalBody", () => {
  it("returns bodyRaw when available", () => {
    const msg: InternalMessage = {
      id: "1",
      type: "t",
      from: "f",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: null,
      bodyRaw: { hello: "world" },
    };
    const body = unmarshalBody<{ hello: string }>(msg);
    expect(body.hello).toBe("world");
  });

  it("falls back to body", () => {
    const msg: InternalMessage = {
      id: "1",
      type: "t",
      from: "f",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: { hello: "world" },
    };
    const body = unmarshalBody<{ hello: string }>(msg);
    expect(body.hello).toBe("world");
  });
});

describe("ack", () => {
  it("calls ackFn when present", () => {
    let calledWith = "";
    const msg: InternalMessage = {
      id: "msg-1",
      type: "t",
      from: "f",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: null,
      ackFn: (id) => {
        calledWith = id;
      },
    };
    ack(msg);
    expect(calledWith).toBe("msg-1");
  });

  it("does nothing when ackFn is not set", () => {
    const msg: InternalMessage = {
      id: "msg-1",
      type: "t",
      from: "f",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: null,
    };
    expect(() => ack(msg)).not.toThrow();
  });
});

describe("createMessage", () => {
  it("creates a message with defaults", () => {
    const msg = createMessage();
    expect(msg.id).toBe("");
    expect(msg.type).toBe("");
    expect(msg.to).toEqual([]);
  });

  it("merges partial input", () => {
    const msg = createMessage({
      type: "test",
      to: ["did:web:bob"],
    });
    expect(msg.type).toBe("test");
    expect(msg.to).toEqual(["did:web:bob"]);
    expect(msg.id).toBe("");
  });
});
