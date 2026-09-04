/**
 * An agent that is not always connected: give it a mediator and it collects
 * whatever arrived while it was away, then keeps live delivery on.
 *
 *   LAYR8_NODE_URL=wss://node/plugin_socket/websocket LAYR8_API_KEY=... \
 *   LAYR8_AGENT_DID=did:web:node:agents:me \
 *   LAYR8_MEDIATOR_DID=did:web:node:agents:mediator \
 *     npx tsx examples/mediated-agent.ts
 */
import { Layr8Client, logErrors } from "../src/index.js";

const client = new Layr8Client(logErrors());

client.handleAll(async (msg) => {
  console.log(`<= ${msg.type} from ${msg.from}:`, JSON.stringify(msg.body));
  return null;
});

await client.connect();
console.log(`connected as ${client.did}; mediator=${client.mediator}`);

// Collected messages arrive through handleAll above; the client re-injects
// each one through the node, so they carry their original sender.
setTimeout(() => void client.close(), 60_000);
