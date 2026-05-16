/**
 * Wildcard binding on reply-protocol nodes.
 * B registers handleAll → receives arbitrary message type.
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../../harness.js";
import { runWildcard } from "../../scenarios/wildcard.js";

const pairings = getPairings({
  receiverNode: { wildcardBinding: true },
});

describe("wildcard binding (handleAll)", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("delivers arbitrary message type via catch-all handler", async () => {
      const testId = `wild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runWildcard(pairing, testId);

      expect(result.error).toBeNull();
      expect(result.response).not.toBeNull();
      expect(result.response!.body).toMatchObject({
        caught: { data: testId },
      });
    });
  });
});
