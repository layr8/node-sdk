/**
 * Echo Agent — a deployable DIDComm echo service built with the Layr8 Node.js SDK.
 *
 * Configuration via environment variables:
 *   LAYR8_NODE_URL  — WebSocket URL of the cloud-node
 *   LAYR8_API_KEY   — API key for authentication
 *   LAYR8_AGENT_DID — DID for this agent
 *   PEER_DIDS       — (optional) comma-separated DIDs to ping every 10s
 *   PEER_DID        — (optional) single DID to ping (backward compat, merged into PEER_DIDS)
 *
 * Usage:
 *   LAYR8_NODE_URL=ws://bob-test.localhost/plugin_socket/websocket \
 *   LAYR8_API_KEY=bob_efgh5678_testkeybobbtestkeybobt24 \
 *   LAYR8_AGENT_DID=did:web:bob-test.localhost:sdk-echo-node \
 *   PEER_DIDS=did:web:alice-test.localhost:sdk-echo-go,did:web:charlie-test.localhost:sdk-echo-py \
 *     npx tsx examples/echo-agent.ts
 */

import { Layr8Client, unmarshalBody } from "../src/index.js";
import type { Message } from "../src/index.js";

const ECHO_PROTOCOL_BASE = "https://layr8.io/protocols/echo/1.0";
const ECHO_REQUEST = `${ECHO_PROTOCOL_BASE}/request`;
const ECHO_RESPONSE = `${ECHO_PROTOCOL_BASE}/response`;

interface EchoRequest {
  message: string;
}

interface EchoResponse {
  echo: string;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${ts} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePeerDIDs(): string[] {
  const peers: string[] = [];
  const dids = process.env.PEER_DIDS;
  if (dids) {
    for (const d of dids.split(",")) {
      const trimmed = d.trim();
      if (trimmed) peers.push(trimmed);
    }
  }
  // Backward compat: merge PEER_DID if not already present
  const single = process.env.PEER_DID;
  if (single && !peers.includes(single)) {
    peers.push(single);
  }
  return peers;
}

function shortDID(did: string): string {
  const parts = did.split(":");
  return parts[parts.length - 1] || did;
}

async function pingLoop(
  client: Layr8Client,
  peerDID: string,
  abortSignal: AbortSignal,
): Promise<void> {
  // Wait for DID propagation across nodes before first ping
  await sleep(30_000);
  if (abortSignal.aborted) return;

  let seq = 0;
  while (!abortSignal.aborted) {
    await sleep(10_000);
    if (abortSignal.aborted) break;

    seq++;
    const msg = `ping #${seq} from ${client.did}`;
    const start = performance.now();

    try {
      const resp = await client.request(
        {
          type: ECHO_REQUEST,
          to: [peerDID],
          body: { message: msg } satisfies EchoRequest,
        },
        { signal: AbortSignal.timeout(5_000) },
      );

      const rtt = Math.round(performance.now() - start);
      const echo = unmarshalBody<EchoResponse>(resp as any);
      log(
        `[→ ${shortDID(peerDID)}] ping #${seq} reply (${rtt}ms): "${echo.echo}"`,
      );
    } catch (err) {
      const rtt = Math.round(performance.now() - start);
      log(
        `[→ ${shortDID(peerDID)}] ping #${seq} failed (${rtt}ms): ${(err as Error).message}`,
      );
    }
  }
}

async function runAgent(outerSignal: AbortSignal): Promise<void> {
  const abortController = new AbortController();

  // If outer signal aborts, abort the inner controller too
  const onOuterAbort = () => abortController.abort();
  outerSignal.addEventListener("abort", onOuterAbort, { once: true });

  const client = new Layr8Client({});

  client.handle(
    ECHO_REQUEST,
    async (msg: Message): Promise<Message | null> => {
      const body = unmarshalBody<EchoRequest>(msg as any);
      log(`echo request from ${msg.from}: "${body.message}"`);

      return {
        id: "",
        type: ECHO_RESPONSE,
        from: "",
        to: [],
        threadId: "",
        parentThreadId: "",
        body: { echo: body.message } satisfies EchoResponse,
      };
    },
  );

  const disconnected = new Promise<Error>((resolve) => {
    client.on("disconnect", (err: Error) => {
      abortController.abort();
      resolve(err);
    });
  });

  await client.connect(outerSignal.aborted ? undefined : outerSignal);
  log(`echo agent running (DID=${client.did})`);

  for (const peer of parsePeerDIDs()) {
    log(`will ping ${peer} every 10s`);
    pingLoop(client, peer, abortController.signal);
  }

  try {
    const err = await Promise.race([
      disconnected,
      new Promise<never>((_, reject) => {
        outerSignal.addEventListener("abort", () => reject(new Error("shutdown")), {
          once: true,
        });
      }),
    ]);
    throw err;
  } catch {
    // either disconnect or shutdown
  } finally {
    outerSignal.removeEventListener("abort", onOuterAbort);
    await client.close();
  }
}

async function main(): Promise<void> {
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  while (!ac.signal.aborted) {
    try {
      await runAgent(ac.signal);
    } catch (err) {
      if (ac.signal.aborted) break;
      log(`disconnected: ${(err as Error).message} — reconnecting in 3s`);
      await sleep(3_000);
    }
  }
  log("shutting down");
}

main();
