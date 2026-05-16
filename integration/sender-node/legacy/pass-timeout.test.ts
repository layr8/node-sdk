/**
 * PASS on legacy receiver nodes.
 * B returns PASS → in legacy mode, no response sent → A times out.
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runPass } from "../../scenarios/pass.js";

const pairings = getPairings({
  receiverNode: { replyProtocol: false },
});

describe("PASS on legacy receiver (timeout)", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("times out when handler PASSes (no dispatch_reply)", async () => {
      const testId = `pass-leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runPass(pairing, testId, { timeout: 3_000 });

      expect(result.error).not.toBeNull();
      // Should be a timeout, NOT a ProblemReportError
      expect(result.error!.name).not.toBe("ProblemReportError");
    });
  });
});
