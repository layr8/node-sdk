import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";
const WILDCARD_RESPONSE_TYPE = "https://layr8.test/wildcard/1.0/response";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Catch-all handler — responds to any message type
  client.handleAll((msg) => ({
    type: WILDCARD_RESPONSE_TYPE,
    body: { received: msg.body, intercepted: true },
  }));

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  // Register handlers so the cloud-node knows we speak these protocols
  client.handle(ECHO_TYPE, () => null);
  client.handle(PING_TYPE, () => null);

  const start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));

    // 1. Send echo request — proves wildcard catches custom protocols
    const echoResp = await client.request(
      { type: ECHO_TYPE, to: [ctx.receiverDid], body: { data: ctx.testId } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    const echoBody = echoResp?.body as Record<string, unknown> | undefined;
    const received = echoBody?.received as Record<string, unknown> | undefined;
    if (received?.data !== ctx.testId) {
      return {
        status: "fail",
        scenario: "wildcard",
        duration_ms: elapsedMs(start),
        error: "echo reply missing expected data",
      };
    }

    // 2. Send trust-ping — proves wildcard catches standard protocols
    const pingResp = await client.request(
      { type: PING_TYPE, to: [ctx.receiverDid], body: { responseRequested: true } },
      { signal: AbortSignal.timeout(ctx.timeout) },
    );
    const pingBody = pingResp?.body as Record<string, unknown> | undefined;
    if (pingBody?.intercepted !== true) {
      return {
        status: "fail",
        scenario: "wildcard",
        duration_ms: elapsedMs(start),
        error: "ping reply missing intercepted field",
      };
    }

    return { status: "pass", scenario: "wildcard", duration_ms: elapsedMs(start) };
  } catch (err) {
    return { status: "fail", scenario: "wildcard", duration_ms: elapsedMs(start), error: String(err) };
  } finally {
    await client.close();
  }
}