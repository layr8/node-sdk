import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ARBITRARY_TYPE = "https://layr8.test/arbitrary/1.0/invoke";
const ARBITRARY_RESPONSE_TYPE = "https://layr8.test/arbitrary/1.0/result";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Catch-all handler — responds to any message type
  client.handleAll((msg) => ({
    type: ARBITRARY_RESPONSE_TYPE,
    body: { caught: msg.body, receivedType: msg.type },
  }));

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handle(ARBITRARY_TYPE, () => null);

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    const resp = await client.request(
      { type: ARBITRARY_TYPE, to: [ctx.receiverDid], body: { data: ctx.testId } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    const body = resp?.body as Record<string, unknown> | undefined;
    const caught = body?.caught as Record<string, unknown> | undefined;
    const pass = caught?.data === ctx.testId;
    return { status: pass ? "pass" : "fail", scenario: "wildcard", duration_ms: elapsedMs(start) };
  } catch (err) {
    return { status: "fail", scenario: "wildcard", duration_ms: elapsedMs(start), error: String(err) };
  } finally {
    await client.close();
  }
}