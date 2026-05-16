/**
 * Echo test — verifies bidirectional request/response on ALL node pairings.
 * This is the foundational integration test proving the full stack works:
 * Traefik → node → Postgres → DID resolution → cross-node delivery → SDK.
 */
import { describe, it, expect } from "vitest";
import { getPairings } from "../harness.js";
import { runEcho } from "../scenarios/echo.js";

const pairings = getPairings({});

describe("echo across all pairings", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("echoes in both directions", async () => {
      const testId = `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await runEcho(pairing, testId);

      // A→B: B's handler echoed A's payload
      expect(result.aToB.body).toMatchObject({
        echo: { ping: testId, direction: "a-to-b" },
      });

      // B→A: A's handler echoed B's payload
      expect(result.bToA.body).toMatchObject({
        echo: { ping: testId, direction: "b-to-a" },
      });
    });
  });
});
