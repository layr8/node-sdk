import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockPhoenixServer } from "./mock-server.js";
import { runSender, registerAndDisconnect } from "../scenarios/disconnected.js";
import type { ScenarioContext, SenderContext } from "../scenarios/types.js";

describe("disconnected scenario", () => {
  let server: MockPhoenixServer;

  beforeAll(async () => {
    server = new MockPhoenixServer();
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it("sender gets error when receiver is disconnected", async () => {
    const receiverDid = "did:web:test:disconn-receiver";
    const receiverCtx: ScenarioContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "disconn-1",
      timeout: 5000,
      agentDid: receiverDid,
    };

    // Register the receiver DID, then disconnect
    await registerAndDisconnect(receiverCtx);

    const senderCtx: SenderContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "disconn-1",
      timeout: 2000,
      receiverDid,
    };

    const result = await runSender(senderCtx);
    expect(result.status).toBe("pass");
    expect(result.scenario).toBe("disconnected");
  });
});