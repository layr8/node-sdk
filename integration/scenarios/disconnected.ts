/**
 * Disconnected scenario — sends a message to a plugin that is not connected.
 * Returns the error or problem report from the sender's perspective.
 */
import { Layr8Client, logErrors, ProblemReportError } from "../../src/index.js";
import type { Pairing } from "../harness.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export interface DisconnectedResult {
  error: Error | null;
  receivedByB: boolean;
}

/**
 * A sends a request to B's DID, but B is not connected.
 * B's DID is registered (created via connect + disconnect) so the
 * node knows about it, but B is offline.
 */
export async function runDisconnected(
  pairing: Pairing,
  testId: string,
  opts?: { timeout?: number },
): Promise<DisconnectedResult> {
  const didA = `did:web:${pairing.sender.name}%3A9000:disconn:${testId}-a`;
  const didB = `did:web:${pairing.receiver.name}%3A9000:disconn:${testId}-b`;

  const clientA = new Layr8Client(logErrors(), {
    nodeUrl: pairing.sender.url,
    apiKey: "test-key",
    agentDid: didA,
  });

  clientA.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));

  // Connect B briefly to register the DID, then disconnect
  const clientB = new Layr8Client(logErrors(), {
    nodeUrl: pairing.receiver.url,
    apiKey: "test-key",
    agentDid: didB,
  });
  clientB.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body },
  }));

  const connectSignal = AbortSignal.timeout(15_000);
  await clientB.connect(connectSignal);
  await clientB.close(); // B is now disconnected

  // Connect A
  await clientA.connect(connectSignal);

  const timeout = opts?.timeout ?? 5_000;
  const requestSignal = AbortSignal.timeout(timeout);
  let error: Error | null = null;

  try {
    await clientA.request(
      { type: ECHO_TYPE, to: [didB], body: { test: testId } },
      { signal: requestSignal },
    );
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    await clientA.close();
  }

  return { error, receivedByB: false };
}
