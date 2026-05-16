/**
 * Disconnected receiver on nodes without store-and-forward (4.14.0+).
 * A sends to B while B is offline. Expects an error (problem report or timeout).
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runDisconnected } from "../../scenarios/disconnected.js";

const pairings = getPairings({
  receiverNode: { storeAndForward: false },
});

describe("disconnected receiver (no store-forward)", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("fails when receiver is disconnected", async () => {
      const testId = `disconn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runDisconnected(pairing, testId);

      // A should get an error — either a ProblemReportError or a timeout
      expect(result.error).not.toBeNull();
      expect(result.receivedByB).toBe(false);
    });
  });
});
