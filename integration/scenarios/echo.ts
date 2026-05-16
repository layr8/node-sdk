/**
 * Echo scenario — connects two plugins and verifies bidirectional
 * request/response across a node pairing.
 */
import { Layr8Client, logErrors } from "../../src/index.js";
import type { Message } from "../../src/index.js";
import type { Pairing } from "../harness.js";

const ECHO_TYPE = "https://layr8.test/echo/1.0/request";
const ECHO_RESPONSE_TYPE = "https://layr8.test/echo/1.0/response";

export interface EchoResult {
  aToB: Message;
  bToA: Message;
}

/**
 * Run the echo scenario on a given pairing.
 * Returns the response messages from both directions.
 */
export async function runEcho(pairing: Pairing, testId: string): Promise<EchoResult> {
  const didA = `did:web:${pairing.sender.name}%3A9000:echo:${testId}-a`;
  const didB = `did:web:${pairing.receiver.name}%3A9000:echo:${testId}-b`;

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

  // Both register echo handlers
  clientA.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body, from: clientA.did },
  }));

  clientB.handle(ECHO_TYPE, (msg) => ({
    type: ECHO_RESPONSE_TYPE,
    body: { echo: msg.body, from: clientB.did },
  }));

  const signal = AbortSignal.timeout(15_000);
  await clientA.connect(signal);
  await clientB.connect(signal);

  try {
    // A sends to B
    const aToB = await clientA.request(
      {
        type: ECHO_TYPE,
        to: [clientB.did],
        body: { ping: testId, direction: "a-to-b" },
      },
      { signal },
    );

    // B sends to A
    const bToA = await clientB.request(
      {
        type: ECHO_TYPE,
        to: [clientA.did],
        body: { ping: testId, direction: "b-to-a" },
      },
      { signal },
    );

    return { aToB, bToA };
  } finally {
    await clientA.close();
    await clientB.close();
  }
}
