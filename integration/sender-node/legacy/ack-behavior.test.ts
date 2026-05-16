/**
 * Legacy ack mode on sender nodes without reply protocol.
 * Verifies echo completes successfully using legacy ack (not dispatch_reply).
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runEcho } from "../../scenarios/echo.js";

const pairings = getPairings({
  senderNode: { replyProtocol: false },
});

describe("sender legacy ack mode", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("completes echo via legacy ack", async () => {
      const testId = `ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runEcho(pairing, testId);

      expect(result.aToB.body).toMatchObject({
        echo: { ping: testId, direction: "a-to-b" },
      });
    });
  });
});
