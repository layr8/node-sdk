import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";
const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";
const PING_RESPONSE_TYPE = "https://didcomm.org/trust-ping/2.0/ping-response";
const WILDCARD_RESPONSE_TYPE = "https://layr8.test/wildcard/1.0/response";

export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handleAll((msg) => {
    let replyType = WILDCARD_RESPONSE_TYPE;
    if (msg.type === ECHO_TYPE) {
      replyType = ECHO_RESPONSE_TYPE;
    } else if (msg.type === PING_TYPE) {
      replyType = PING_RESPONSE_TYPE;
    }
    return {
      type: replyType,
      body: { received: msg.body, intercepted: true },
    };
  });

  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  await new Promise(() => {});
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));

  client.handle(ECHO_TYPE, () => null);
  client.handle(PING_TYPE, () => null);

  let start = Date.now();
  try {
    await client.connect(AbortSignal.timeout(ctx.timeout));
    start = Date.now();

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