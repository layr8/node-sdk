/**
 * Durable Handler — persist messages to a file before acknowledging.
 *
 * Demonstrates manual ack: messages are only acknowledged after they
 * are safely written to disk. If the process crashes between receive
 * and ack, the cloud-node redelivers the message.
 *
 * Messages are appended as JSON lines to messages.jsonl.
 *
 * Usage:
 *   LAYR8_API_KEY=your-key npx tsx examples/durable-handler.ts
 */

import { appendFileSync } from "node:fs";
import { Layr8Client, ack } from "../src/index.js";
import type { Message } from "../src/index.js";

const FILE_PATH = "messages.jsonl";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${ts} ${msg}`);
}

const client = new Layr8Client({});

client.handle(
  "https://layr8.io/protocols/order/1.0/created",
  async (msg: Message): Promise<null> => {
    const record = JSON.stringify({
      id: msg.id,
      type: msg.type,
      from: msg.from,
      body: msg.body,
    });

    // Persist first — if this throws, the message is NOT acked
    // and the cloud-node will redeliver it.
    appendFileSync(FILE_PATH, record + "\n");

    ack(msg as any); // safe to ack now
    log(`persisted and acked message ${msg.id} from ${msg.from}`);
    return null;
  },
  { manualAck: true },
);

await client.connect();
log(`durable handler running (DID=${client.did}), persisting to ${FILE_PATH}`);

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});
