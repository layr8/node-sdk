/**
 * Store-and-forward on pre-4.14.0 nodes.
 * When B is disconnected, A's send fails (stored by node).
 * When B reconnects, B receives the stored message.
 */
import { describe, it, expect } from "vitest";
import { Layr8Client, logErrors } from "../../../src/index.js";
import type { Message } from "../../../src/index.js";
import { getPairings } from "../../harness.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

const pairings = getPairings({
  receiverNode: { storeAndForward: true },
});

describe("disconnected receiver (store-forward)", () => {
  describe.each(pairings.map((p) => ({
    name: `${p.sender.name} → ${p.receiver.name}`,
    pairing: p,
  })))("$name", ({ pairing }) => {
    it("stores message and delivers on reconnect", async () => {
      const testId = `sf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const didA = `did:web:${pairing.sender.name}%3A9000:sf:${testId}-a`;
      const didB = `did:web:${pairing.receiver.name}%3A9000:sf:${testId}-b`;

      // Connect B briefly to register DID, then disconnect
      const clientBSetup = new Layr8Client(logErrors(), {
        nodeUrl: pairing.receiver.url,
        apiKey: "test-key",
        agentDid: didB,
      });
      clientBSetup.handle(ECHO_TYPE, () => null);
      await clientBSetup.connect(AbortSignal.timeout(15_000));
      await clientBSetup.close();

      // Connect A and send while B is offline
      const clientA = new Layr8Client(logErrors(), {
        nodeUrl: pairing.sender.url,
        apiKey: "test-key",
        agentDid: didA,
      });
      clientA.handle(ECHO_TYPE, () => null);
      await clientA.connect(AbortSignal.timeout(15_000));

      // Send message — A will get an error (timeout or problem report)
      try {
        await clientA.request(
          { type: ECHO_TYPE, to: [didB], body: { test: testId } },
          { signal: AbortSignal.timeout(5_000) },
        );
      } catch {
        // Expected — A doesn't get a successful response while B is offline
      }

      // Now reconnect B and verify it receives the stored message
      let receivedMsg: Message | null = null;
      const clientB = new Layr8Client(logErrors(), {
        nodeUrl: pairing.receiver.url,
        apiKey: "test-key",
        agentDid: didB,
      });
      clientB.handle(ECHO_TYPE, (msg) => {
        receivedMsg = msg;
        return {
          type: ECHO_RESPONSE_TYPE,
          body: { echo: msg.body },
        };
      });
      await clientB.connect(AbortSignal.timeout(15_000));

      // Wait for stored message delivery
      await new Promise((r) => setTimeout(r, 3_000));

      expect(receivedMsg).not.toBeNull();
      expect(receivedMsg!.body).toMatchObject({ test: testId });

      await clientA.close();
      await clientB.close();
    });
  });
});
