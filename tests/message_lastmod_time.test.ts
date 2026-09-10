import { describe, it, expect } from "vitest";
import { parseDIDComm, marshalDIDComm } from "../src/message.js";
import type { Attachment } from "../src/message.js";

/**
 * `lastmod_time` arrives in two forms and the type has to admit both.
 *
 * These are as much a compile-time assertion as a runtime one: `npm run lint`
 * type-checks this file against the published `Attachment`, so narrowing
 * `lastmod_time` back to `string` alone fails the build here, not only in a
 * consumer's repo six weeks later.
 */
describe("attachment lastmod_time", () => {
  const denial = (lastmod: number | string | undefined) => ({
    context: {
      recipient: "did:web:test:agents:bolt",
      authorized: false,
      sender_credentials: [],
    },
    plaintext: {
      id: "msg-denied",
      type: "https://didcomm.org/report-problem/2.0/problem-report",
      from: "did:web:test:node",
      to: ["did:web:test:agents:bolt"],
      pthid: "thread-1",
      body: { code: "e.m.authz.denied", comment: "denied" },
      attachments: [
        {
          id: "helix-decision",
          media_type: "application/json",
          ...(lastmod === undefined ? {} : { lastmod_time: lastmod }),
          data: { json: { reason: "no_grant" } },
        },
      ],
    },
  });

  it("accepts an integer, the form both DIF reference implementations use", () => {
    const att: Attachment = {
      id: "helix-decision",
      lastmod_time: 1789035360,
      data: { json: {} },
    };
    expect(att.lastmod_time).toBe(1789035360);

    const parsed = parseDIDComm(denial(1789035360));
    expect(parsed.attachments?.[0].lastmod_time).toBe(1789035360);
  });

  it("accepts an ISO-8601 string, the form a cloud-node sends today", () => {
    const att: Attachment = {
      id: "helix-decision",
      lastmod_time: "2026-09-10T10:16:00.000000Z",
      data: { json: {} },
    };
    expect(att.lastmod_time).toBe("2026-09-10T10:16:00.000000Z");

    const parsed = parseDIDComm(denial("2026-09-10T10:16:00.000000Z"));
    expect(parsed.attachments?.[0].lastmod_time).toBe("2026-09-10T10:16:00.000000Z");
  });

  it("keeps absent, integer and string as three distinct values", () => {
    const absent = parseDIDComm(denial(undefined)).attachments?.[0].lastmod_time;
    const asNumber = parseDIDComm(denial(1789035360)).attachments?.[0].lastmod_time;
    const asString = parseDIDComm(denial("2026-09-10T10:16:00.000000Z"))
      .attachments?.[0].lastmod_time;

    // Absent is not a value. It is not zero, not the empty string, and not
    // some default this SDK invented on the sender's behalf.
    expect(absent).toBeUndefined();
    expect(typeof asNumber).toBe("number");
    expect(typeof asString).toBe("string");

    // Pairwise distinct.
    expect(absent).not.toBe(asNumber);
    expect(absent).not.toBe(asString);
    expect(asNumber).not.toBe(asString);
  });

  it("passes the value through untouched, in both directions", () => {
    // This SDK does not normalize the hint. A caller reads what the peer sent,
    // and relaying a message does not rewrite a field this SDK did not author.
    const iso = "2026-09-10T10:16:00.000000Z";
    const parsed = parseDIDComm(denial(iso));
    const wire = JSON.parse(marshalDIDComm(parsed as never));
    expect(wire.attachments[0].lastmod_time).toBe(iso);
  });
});
