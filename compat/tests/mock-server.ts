import { WebSocketServer, WebSocket } from "ws";

const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";
const PING_RESPONSE_TYPE = "https://didcomm.org/trust-ping/2.0/ping-response";

interface ConnectedClient {
  ws: WebSocket;
  did: string;
  topic: string;
}

interface PendingDispatch {
  senderDid: string;
  plaintext: Record<string, unknown>;
}

/**
 * Minimal Phoenix Channel V2 mock server.
 * Simulates cloud-node behavior for compat scenario tests:
 * - Accepts phx_join, assigns DID from topic
 * - Relays messages to recipients by DID
 * - Supports reply_protocol/1 (dispatch_reply routing)
 */
export class MockPhoenixServer {
  private server: WebSocketServer | null = null;
  private clients: ConnectedClient[] = [];
  private pendingDispatches = new Map<string, PendingDispatch>();
  private port = 0;

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = new WebSocketServer({ port: 0 }, () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        resolve();
      });
      this.server.on("connection", (ws) => this.handleConnection(ws));
    });
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/plugin_socket/websocket`;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.ws.close();
    }
    this.clients = [];
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleConnection(ws: WebSocket): void {
    let client: ConnectedClient | null = null;

    ws.on("message", (raw) => {
      const arr = JSON.parse(raw.toString()) as [
        string | null, string | null, string, string, unknown
      ];
      const [, ref, topic, event, payload] = arr;

      if (event === "phx_join") {
        const did = topic.replace("plugins:", "");
        client = { ws, did, topic };
        this.clients.push(client);

        ws.send(JSON.stringify([
          ref, ref, topic, "phx_reply",
          {
            status: "ok",
            response: {
              did,
              capabilities: ["reply_protocol/1"],
            },
          },
        ]));
      } else if (event === "message") {
        // Ack the send
        if (ref) {
          ws.send(JSON.stringify([
            null, ref, topic, "phx_reply",
            { status: "ok", response: {} },
          ]));
        }

        // Parse the DIDComm envelope to find recipients
        const envelope = typeof payload === "string" ? payload : JSON.stringify(payload);
        let recipients: string[] = [];
        try {
          const parsed = JSON.parse(envelope);
          recipients = parsed.to ?? [];
        } catch {
          // If we can't parse, relay to all others
        }

        // Relay to matching recipients
        const parsed = JSON.parse(envelope);
        for (const other of this.clients) {
          if (other.ws === ws) continue;
          if (recipients.length > 0 && !recipients.includes(other.did)) continue;

          // Track dispatched message for trust-ping fallback on PASS
          const msgId = parsed.id;
          if (msgId && client) {
            this.pendingDispatches.set(`${other.did}:${msgId}`, {
              senderDid: client.did,
              plaintext: parsed,
            });
          }

          other.ws.send(JSON.stringify([
            null, null, other.topic, "message",
            {
              context: {
                recipient: other.did,
                authorized: true,
                sender_credentials: [],
              },
              plaintext: parsed,
            },
          ]));
        }
      } else if (event === "dispatch_reply") {
        if (ref) {
          ws.send(JSON.stringify([
            null, ref, topic, "phx_reply",
            { status: "ok", response: {} },
          ]));
        }

        const replyPayload = payload as { message_id: string; status: string };

        // On PASS, simulate cloud-node built-in trust-ping handling
        if (replyPayload.status === "pass" && client) {
          const key = `${client.did}:${replyPayload.message_id}`;
          const pending = this.pendingDispatches.get(key);
          this.pendingDispatches.delete(key);

          if (pending && pending.plaintext.type === PING_TYPE) {
            const body = pending.plaintext.body as Record<string, unknown> | undefined;
            if (body?.responseRequested) {
              // Send built-in ping-response back to the original sender
              const sender = this.clients.find((c) => c.did === pending.senderDid);
              if (sender) {
                const responseId = `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                sender.ws.send(JSON.stringify([
                  null, null, sender.topic, "message",
                  {
                    context: {
                      recipient: sender.did,
                      authorized: true,
                      sender_credentials: [],
                    },
                    plaintext: {
                      id: responseId,
                      type: PING_RESPONSE_TYPE,
                      from: client.did,
                      to: [sender.did],
                      thid: pending.plaintext.thid || pending.plaintext.id,
                      body: {},
                    },
                  },
                ]));
              }
            }
          }
        }
      } else if (event === "heartbeat" || event === "phx_heartbeat") {
        ws.send(JSON.stringify([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]));
      }
    });

    ws.on("close", () => {
      this.clients = this.clients.filter((c) => c.ws !== ws);
    });
  }
}