import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";
import { elapsedMs, clientConfig } from "./types.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

/**
 * Briefly connect to register the DID, then disconnect.
 * Used by Layer 1 tests. In Layer 2, the orchestrator handles
 * receiver lifecycle separately (receiver mode connects then exits).
 */
export async function registerAndDisconnect(ctx: ScenarioContext): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));
  client.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));
  await client.connect(AbortSignal.timeout(ctx.timeout));
  await client.close();
}

/**
 * Receiver for Layer 2 CLI: connect, emit ready, then immediately close.
 * The orchestrator will wait for the ready signal before launching the sender.
 */
export async function runReceiver(
  ctx: ScenarioContext,
  onReady?: (did: string) => void,
): Promise<void> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));
  client.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));
  await client.connect(AbortSignal.timeout(ctx.timeout));
  if (onReady) onReady(client.did);
  // Disconnect immediately — the whole point is the receiver is offline
  await client.close();
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = new Layr8Client(logErrors(), clientConfig(ctx));
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
    // If request succeeds, receiver somehow got the message — unexpected
    return {
      status: "fail",
      scenario: "disconnected",
      duration_ms: elapsedMs(start),
      error: "expected error but got success",
    };
  } catch {
    // Timeout or problem report means the disconnected scenario worked
    return { status: "pass", scenario: "disconnected", duration_ms: elapsedMs(start) };
  } finally {
    await client.close();
  }
}