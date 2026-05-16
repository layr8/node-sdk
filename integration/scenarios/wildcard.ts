/**
 * Wildcard scenario — B registers handleAll (catch-all) and receives
 * an arbitrary message type that was never explicitly registered.
 */
import { Layr8Client, logErrors } from "../../src/index.js";
import type { Message } from "../../src/index.js";
import type { Pairing } from "../harness.js";

const ARBITRARY_TYPE = "https://layr8.test/arbitrary/1.0/invoke";
const ARBITRARY_RESPONSE_TYPE = "https://layr8.test/arbitrary/1.0/result";

export interface WildcardResult {
  response: Message | null;
  error: Error | null;
}

export async function runWildcard(
  pairing: Pairing,
  testId: string,
): Promise<WildcardResult> {
  const didA = `did:web:${pairing.sender.name}%3A9000:wild:${testId}-a`;
  const didB = `did:web:${pairing.receiver.name}%3A9000:wild:${testId}-b`;

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

  // A registers a dummy handler (required for connect)
  clientA.handle(ARBITRARY_TYPE, () => null);

  // B registers handleAll — catch-all for any message type
  clientB.handleAll((msg) => ({
    type: ARBITRARY_RESPONSE_TYPE,
    body: { caught: msg.body, receivedType: msg.type },
  }));

  const signal = AbortSignal.timeout(15_000);
  await clientA.connect(signal);
  await clientB.connect(signal);

  let response: Message | null = null;
  let error: Error | null = null;

  try {
    response = await clientA.request(
      { type: ARBITRARY_TYPE, to: [clientB.did], body: { data: testId } },
      { signal },
    );
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    await clientA.close();
    await clientB.close();
  }

  return { response, error };
}
