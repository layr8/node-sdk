/**
 * PASS on reply-protocol nodes.
 * B returns PASS → dispatch_reply pass → node generates problem report.
 * A receives an error (either ProblemReportError or timeout).
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runPass } from "../../scenarios/pass.js";

const pairings = getPairings({
  receiverNode: { replyProtocol: true },
});

describe("PASS on reply-protocol receiver", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("fails when handler PASSes", async () => {
      const testId = `pass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runPass(pairing, testId);

      // A should get an error — the handler declined the message
      expect(result.error).not.toBeNull();
    });
  });
});
