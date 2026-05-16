/**
 * Dispatch-reply mode on sender nodes with reply protocol.
 * Verifies echo completes successfully using dispatch_reply (not ack).
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runEcho } from "../../scenarios/echo.js";

const pairings = getPairings({
  senderNode: { replyProtocol: true },
});

describe("sender dispatch_reply mode", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("completes echo via dispatch_reply", async () => {
      const testId = `dr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runEcho(pairing, testId);

      expect(result.aToB.body).toMatchObject({
        echo: { ping: testId, direction: "a-to-b" },
      });
    });
  });
});
