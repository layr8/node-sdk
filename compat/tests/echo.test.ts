import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockPhoenixServer } from "./mock-server.js";
import { runReceiver, runSender } from "../scenarios/echo.js";
import type { ScenarioContext, SenderContext } from "../scenarios/types.js";

describe("echo scenario", () => {
  let server: MockPhoenixServer;

  beforeAll(async () => {
    server = new MockPhoenixServer();
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it("sender receives echoed response", async () => {
    const receiverDid = "did:web:test:echo-receiver";
    const receiverCtx: ScenarioContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "echo-1",
      timeout: 5000,
      agentDid: receiverDid,
    };

    let ready = false;
    const receiverPromise = runReceiver(receiverCtx, () => { ready = true; });

    // Wait for receiver to connect
    await new Promise<void>((resolve) => {
      const check = () => { if (ready) resolve(); else setTimeout(check, 10); };
      check();
    });

    const senderCtx: SenderContext = {
      nodeUrl: server.wsUrl,
      apiKey: "test-key",
      testId: "echo-1",
      timeout: 5000,
      receiverDid,
    };

    const result = await runSender(senderCtx);
    expect(result.status).toBe("pass");
    expect(result.scenario).toBe("echo");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });
});