import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body, from: client.did },
  }));

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);

  // Block until process is killed (CLI) or test cleans up
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Register a dummy handler so the node accepts us
  client.handle(ECHO_TYPE, () => null);

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    const resp = await client.request(
      { type: ECHO_TYPE, to: [ctx.receiverDid], body: { ping: ctx.testId } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    const body = resp?.body as Record<string, unknown> | undefined;
    const echo = body?.echo as Record<string, unknown> | undefined;
    const pass = echo?.ping === ctx.testId;
    return { status: pass ? "pass" : "fail", scenario: "echo", duration_ms: elapsedMs(start) };
  } catch (err) {
    return { status: "fail", scenario: "echo", duration_ms: elapsedMs(start), error: String(err) };
  } finally {
    await client.close();
  }
}