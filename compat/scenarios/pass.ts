import { Layr8Client, logErrors, PASS } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handle(ECHO_TYPE, () => PASS);

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handle(ECHO_TYPE, () => null);

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    await client.request(
      { type: ECHO_TYPE, to: [ctx.receiverDid], body: {} },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    // If request succeeds, the PASS scenario failed
    return { status: "fail", scenario: "pass", duration_ms: elapsedMs(start) };
  } catch (err) {
    // Timeout or error indicates PASS behavior
    return { status: "pass", scenario: "pass", duration_ms: elapsedMs(start), error: String(err) };
  } finally {
    await client.close();
  }
}