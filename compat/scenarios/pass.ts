import { Layr8Client, logErrors, PASS } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), {
    nodeUrl: ctx.nodeUrl,
    apiKey: ctx.apiKey,
    agentDid: ctx.agentDid,
  });

  // Handler returns PASS — intentionally declines the message
  client.handle(ECHO_TYPE, () => PASS);

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), {
    nodeUrl: ctx.nodeUrl,
    apiKey: ctx.apiKey,
    agentDid: ctx.agentDid,
  });

  client.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    await client.request(
      { type: ECHO_TYPE, to: [ctx.receiverDid], body: { test: ctx.testId } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    // If request succeeds, that's unexpected — PASS should cause an error
    return { status: "fail", scenario: "pass", duration_ms: elapsedMs(start), error: "expected error but got success" };
  } catch {
    // Any error (ProblemReportError or timeout) means PASS worked correctly
    return { status: "pass", scenario: "pass", duration_ms: elapsedMs(start) };
  } finally {
    await client.close();
  }
}