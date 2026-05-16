/**
 * PASS scenario — B's handler returns PASS for the echo protocol.
 * On reply-protocol nodes: dispatch_reply pass → problem report.
 * On legacy nodes: no response sent → timeout.
 */
import { Layr8Client, logErrors, PASS } from "../../src/index.js";
import type { Pairing } from "../harness.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export interface PassResult {
  error: Error | null;
}

export async function runPass(
  pairing: Pairing,
  testId: string,
  opts?: { timeout?: number },
): Promise<PassResult> {
  const didA = `did:web:${pairing.sender.name}%3A9000:pass:${testId}-a`;
  const didB = `did:web:${pairing.receiver.name}%3A9000:pass:${testId}-b`;

  const clientA = new Layr8Client(logErrors(), {
    nodeUrl: pairing.sender.url,
    apiKey: "test-key",
    agentDid: didA,
  });

  const clientB = new Layr8Client(logErrors(), {
    nodeUrl: pairing.receiver.url,
    apiKey: "test-key",
    agentDid: didB,
  });

  clientA.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));

  // B's handler returns PASS — intentionally declines the message
  clientB.handle(ECHO_TYPE, () => PASS);

  const signal = AbortSignal.timeout(15_000);
  await clientA.connect(signal);
  await clientB.connect(signal);

  const timeout = opts?.timeout ?? 5_000;
  const requestSignal = AbortSignal.timeout(timeout);
  let error: Error | null = null;

  try {
    await clientA.request(
      { type: ECHO_TYPE, to: [clientB.did], body: { test: testId } },
      { signal: requestSignal },
    );
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    await clientA.close();
    await clientB.close();
  }

  return { error };
}
