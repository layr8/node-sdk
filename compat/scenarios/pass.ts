import { Layr8Client, logErrors, PASS } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Handler returns PASS — intentionally declines the message so the
  // cloud-node's built-in trust-ping handler can send a ping-response.
  client.handle(PING_TYPE, () => PASS);

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Register handler so the cloud-node knows we speak this protocol
  client.handle(PING_TYPE, () => null);

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    await client.request(
      { type: PING_TYPE, to: [ctx.receiverDid], body: { responseRequested: true } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    // Success means the cloud-node handled the trust-ping after PASS
    return { status: "pass", scenario: "pass", duration_ms: elapsedMs(start) };
  } catch (err) {
    // Timeout or error means something went wrong
    return { status: "fail", scenario: "pass", duration_ms: elapsedMs(start), error: String(err) };
  } finally {
    await client.close();
  }
}