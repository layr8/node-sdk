/**
 * Durable Handler — persist messages to SQLite before acknowledging.
 *
 * Demonstrates manual ack: messages are only acknowledged after they
 * are safely written to disk. If the process crashes between receive
 * and ack, the cloud-node redelivers the message.
 *
 * Prerequisites:
 *   npm install better-sqlite3 @types/better-sqlite3
 *
 * Usage:
 *   LAYR8_API_KEY=your-key npx tsx examples/durable-handler.ts
 */

import Database from "better-sqlite3";
import { Layr8Client, ack } from "../src/index.js";
import type { Message } from "../src/index.js";

const DB_PATH = "messages.db";

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id       TEXT PRIMARY KEY,
    type     TEXT NOT NULL,
    from_did TEXT NOT NULL,
    body     TEXT NOT NULL
  )
`);

const insert = db.prepare(
  `INSERT OR IGNORE INTO messages (id, type, from_did, body) VALUES (?, ?, ?, ?)`,
);

const client = new Layr8Client({});

client.handle(
  "https://layr8.io/protocols/order/1.0/created",
  async (msg: Message): Promise<null> => {
    const bodyJSON = JSON.stringify(msg.body);

    // Persist first — if this throws, the message is NOT acked
    // and the cloud-node will redeliver it.
    insert.run(msg.id, msg.type, msg.from, bodyJSON);

    ack(msg as any); // safe to ack now
    console.log(`persisted and acked message ${msg.id} from ${msg.from}`);
    return null;
  },
  { manualAck: true },
);

await client.connect();
console.log(`durable handler running (DID=${client.did}), persisting to ${DB_PATH}`);

process.on("SIGINT", async () => {
  await client.close();
  db.close();
  process.exit(0);
});
