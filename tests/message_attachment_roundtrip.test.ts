import { describe, it, expect } from "vitest";
import { parseDIDComm, marshalDIDComm, createMessage } from "../src/message.js";

describe("attachment roundtrip", () => {
  it("parseDIDComm preserves attachments from cloud-node wire format", () => {
    // Simulate what the cloud-node sends over the WebSocket
    const wirePayload = {
      context: {
        recipient: "did:web:test:agents:bolt",
        authorized: true,
      },
      plaintext: {
        id: "msg-001",
        type: "https://layr8.io/protocols/vg-request/1.0/response",
        from: "did:web:test:sage-controller",
        to: ["did:web:test:agents:bolt"],
        thid: "thread-123",
        pthid: "parent-456",
        body: {
          outcome: "granted",
          decision_trace: {
            overall: "attenuated",
            policy_id: "demo-ttl-cap/v1",
            narrowing: [{ field: "valid_until", requested: "2026-04-19T16:00Z", issued: "2026-04-19T15:30Z", reason: "ttl-cap" }],
          },
        },
        attachments: [
          {
            id: "grant",
            media_type: "application/vc+jwt",
            format: "layr8/verifiable-grant@v1.0",
            data: { base64: "eyJ0ZXN0IjoiZGF0YSJ9" },
          },
        ],
      },
    };

    const parsed = parseDIDComm(wirePayload);

    expect(parsed.type).toBe("https://layr8.io/protocols/vg-request/1.0/response");
    expect(parsed.attachments).toBeDefined();
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments![0].format).toBe("layr8/verifiable-grant@v1.0");
    expect(parsed.attachments![0].data.base64).toBe("eyJ0ZXN0IjoiZGF0YSJ9");
  });

  it("marshalDIDComm includes attachments in outbound envelope", () => {
    const msg = createMessage({
      type: "https://layr8.io/protocols/vg-request/1.0/propose-credential",
      from: "did:web:test:agents:bolt",
      to: ["did:web:test:sage-controller"],
      body: { goal_code: "layr8.verifiable-grant.request" },
      attachments: [
        {
          id: "vg-request",
          media_type: "application/json",
          format: "layr8/verifiable-grant-request@v1.0",
          data: { json: { subject: "did:web:test:agents:bolt", actions: ["send"] } },
        },
      ],
    });

    const json = marshalDIDComm(msg);
    const envelope = JSON.parse(json);

    expect(envelope.attachments).toBeDefined();
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments[0].format).toBe("layr8/verifiable-grant-request@v1.0");
    expect(envelope.attachments[0].data.json.actions).toEqual(["send"]);
  });

  it("parseDIDComm handles missing attachments gracefully", () => {
    const wirePayload = {
      plaintext: {
        id: "msg-002",
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: "did:web:test:alice",
        to: ["did:web:test:bob"],
        body: { content: "hello" },
      },
    };

    const parsed = parseDIDComm(wirePayload);
    expect(parsed.attachments).toBeUndefined();
  });
});
