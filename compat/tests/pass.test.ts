import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockPhoenixServer } from "./mock-server.js";
import { runReceiver, runSender } from "../scenarios/pass.js";
import type { ScenarioContext, SenderContext } from "../scenarios/types.js";

describe("pass scenario", () => {
  let server: MockPhoenixServer;

  beforeAll(async () => {
    server = new MockPhoenixServer();
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it("sender gets an error when receiver returns PASS", async () => {
    const receiverDid = "did:web:test:pass-receiver";
    const receiverCtx: ScenarioContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "pass-1",
      timeout: 5000,
      agentDid: receiverDid,
    };

    let ready = false;
    const receiverPromise = runReceiver(receiverCtx, () => { ready = true; });

    await new Promise<void>((resolve) => {
      const check = () => { if (ready) resolve(); else setTimeout(check, 10); };
      check();
    });

    const senderCtx: SenderContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "pass-1",
      timeout: 3000,
      receiverDid,
    };

    const result = await runSender(senderCtx);
    expect(result.status).toBe("pass");
    expect(result.scenario).toBe("pass");
  });
});