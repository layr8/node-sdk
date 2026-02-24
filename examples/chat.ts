/**
 * Chat Client — a simple DIDComm chat rewritten using the Layr8 Node.js SDK.
 *
 * Demonstrates: Send (fire-and-forget), Handle (inbound), MessageContext,
 * multi-recipient, graceful shutdown.
 *
 * Usage:
 *   LAYR8_NODE_URL=wss://earth.node.layr8.org:443/plugin_socket/websocket \
 *   LAYR8_AGENT_DID=did:web:earth:my-agent \
 *   LAYR8_API_KEY=my-key \
 *     npx tsx examples/chat.ts did:web:other-node:agent
 */

import * as readline from "node:readline";
import { Layr8Client, unmarshalBody, ProblemReportError } from "../src/index.js";
import type { Message } from "../src/index.js";

interface ChatMessage {
  content: string;
  locale: string;
}

async function main(): Promise<void> {
  const recipients = process.argv.slice(2);
  if (recipients.length === 0) {
    console.error("usage: chat <recipient-did> [recipient-did...]");
    process.exit(1);
  }

  const client = new Layr8Client({});

  // Receive chat messages
  client.handle(
    "https://didcomm.org/basicmessage/2.0/message",
    async (msg: Message): Promise<Message | null> => {
      const body = unmarshalBody<ChatMessage>(msg as any);

      let sender = msg.from;
      if (msg.context?.senderCredentials?.length) {
        sender = msg.context.senderCredentials[0].name;
      }

      console.log(`[${sender}] ${body.content}`);
      return null;
    },
  );

  // Handle problem reports
  client.handle(
    "https://didcomm.org/report-problem/2.0/problem-report",
    async (msg: Message): Promise<Message | null> => {
      const body = unmarshalBody<{ code: string; comment: string }>(msg as any);
      console.log(`server: [${body.code}] ${body.comment}`);
      return null;
    },
  );

  client.on("disconnect", () => console.log("--- disconnected ---"));
  client.on("reconnect", () => console.log("--- reconnected ---"));

  const ac = new AbortController();
  process.on("SIGINT", () => {
    ac.abort();
    rl.close();
  });

  await client.connect(ac.signal);
  console.log(`chatting with ${recipients.join(", ")}`);
  console.log("type a message and press enter (Ctrl+C to quit)");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;

    try {
      await client.send({
        type: "https://didcomm.org/basicmessage/2.0/message",
        to: recipients,
        body: { content: text, locale: "en" } satisfies ChatMessage,
      });
    } catch (err) {
      console.log(`send error: ${(err as Error).message}`);
    }
  }

  await client.close();
}

main();
