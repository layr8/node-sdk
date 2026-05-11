# Layr8 Node.js SDK

The official Node.js SDK for building agents on the [Layr8](https://layr8.com) platform. Agents connect to Layr8 cloud-nodes via WebSocket and exchange [DIDComm v2](https://identity.foundation/didcomm-messaging/spec/) messages with other agents across the network.

## Installation

```bash
npm install @layr8/sdk
```

Requires Node.js 20 or later. The package is ESM-only (`"type": "module"`).

## Quick Start

```typescript
import { Layr8Client, unmarshalBody, logErrors } from "@layr8/sdk";
import type { Message } from "@layr8/sdk";

interface EchoRequest {
  message: string;
}

const client = new Layr8Client(logErrors(), {
  nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
  apiKey: "your-api-key",
  agentDid: "did:web:myorg:my-agent",
});

client.handle(
  "https://layr8.io/protocols/echo/1.0/request",
  async (msg: Message): Promise<Message | null> => {
    const body = unmarshalBody<EchoRequest>(msg as any);
    return {
      id: "",
      type: "https://layr8.io/protocols/echo/1.0/response",
      from: "",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: { echo: body.message },
    };
  },
);

await client.connect();
console.log(`agent running as ${client.did}`);

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});
```

## Core Concepts

### Client

The `Layr8Client` is the main entry point. It manages the WebSocket connection to a cloud-node, routes inbound messages to handlers, and provides methods for sending outbound messages.

```typescript
const client = new Layr8Client(logErrors(), {...});

// Register handlers before connecting
client.handle(messageType, handlerFn);

// Connect to the cloud-node
await client.connect();
```

### Messages

`Message` represents a DIDComm v2 message with standard fields:

```typescript
interface Message {
  id: string;             // unique message ID (auto-generated if empty)
  type: string;           // DIDComm message type URI
  from: string;           // sender DID (auto-filled from client)
  to: string[];           // recipient DIDs
  threadId: string;       // thread correlation ID
  parentThreadId: string; // parent thread for nested conversations
  body: unknown;          // message payload (serialized to JSON)
  context?: MessageContext; // cloud-node metadata (inbound only)
}
```

Decode the body of an inbound message with `unmarshalBody`:

```typescript
const req = unmarshalBody<MyRequest>(msg as any);
```

### Handlers

Handlers process inbound messages. Register them with `client.handle()` before calling `connect()`.

A handler receives a `Message` and returns:

| Return value | Behavior |
|---|---|
| `Message` | Sends response to the sender. `from`, `to`, and `threadId` are auto-filled. |
| `null` | Fire-and-forget — no response sent. |
| Thrown error | Sends a DIDComm [problem report](https://identity.foundation/didcomm-messaging/spec/#problem-reports) to the sender. |

```typescript
client.handle(
  "https://layr8.io/protocols/echo/1.0/request",
  async (msg: Message): Promise<Message | null> => {
    const body = unmarshalBody<EchoRequest>(msg as any);
    return {
      id: "",
      type: "https://layr8.io/protocols/echo/1.0/response",
      from: "",
      to: [],
      threadId: "",
      parentThreadId: "",
      body: { echo: body.message },
    };
  },
);
```

#### Protocol Registration

The SDK automatically derives protocol base URIs from your handler message types and registers them with the cloud-node on connect. For example, handling `https://layr8.io/protocols/echo/1.0/request` registers the protocol `https://layr8.io/protocols/echo/1.0`.

## Sending Messages

### Send

Send a one-way message. By default, `send()` waits for the server to acknowledge receipt:

```typescript
await client.send({
  type: "https://didcomm.org/basicmessage/2.0/message",
  to: ["did:web:other-org:their-agent"],
  body: { content: "hello!" },
});
```

`send()` accepts `Partial<Message>` — only `type`, `to`, and `body` are required.

To skip waiting for the server acknowledgment, pass `{ fireAndForget: true }`:

```typescript
await client.send(
  {
    type: "https://didcomm.org/basicmessage/2.0/message",
    to: ["did:web:other-org:their-agent"],
    body: { content: "hello!" },
  },
  { fireAndForget: true },
);
```

#### Send Options

```typescript
interface SendOptions {
  fireAndForget?: boolean; // skip waiting for server ack (default: false)
}
```

### Request (Request/Response)

Send a message and await a correlated response:

```typescript
const resp = await client.request(
  {
    type: "https://layr8.io/protocols/echo/1.0/request",
    to: ["did:web:other-org:echo-agent"],
    body: { message: "ping" },
  },
  { signal: AbortSignal.timeout(5_000) },
);

const result = unmarshalBody<EchoResponse>(resp as any);
console.log(result.echo); // "ping"
```

Thread correlation is automatic — the SDK generates a `threadId`, attaches it to the outbound message, and matches the inbound response by the same `threadId`.

#### Request Options

```typescript
interface RequestOptions {
  parentThread?: string;  // parent thread ID for nested conversations
  signal?: AbortSignal;   // abort/timeout control
}
```

## Configuration

Configuration can be set explicitly or via environment variables. Environment variables are used as fallbacks when the corresponding field is empty or undefined.

| Field | Environment Variable | Required | Description |
|---|---|---|---|
| `nodeUrl` | `LAYR8_NODE_URL` | Yes | WebSocket URL of the cloud-node |
| `apiKey` | `LAYR8_API_KEY` | Yes | API key for authentication |
| `agentDid` | `LAYR8_AGENT_DID` | No | Agent DID identity |

If `agentDid` is not provided, the cloud-node creates an ephemeral DID on connect. Retrieve it with `client.did`.

```typescript
// Explicit configuration
const client = new Layr8Client(logErrors(), {
  nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
  apiKey: "my-api-key",
  agentDid: "did:web:myorg:my-agent",
});

// Environment-only configuration
// Set LAYR8_NODE_URL, LAYR8_API_KEY, LAYR8_AGENT_DID
const client = new Layr8Client(logErrors());
```

## Handler Options

### Manual Acknowledgment

By default, messages are acknowledged to the cloud-node before the handler runs (auto-ack). For handlers where you need guaranteed processing, use manual ack to acknowledge only after successful execution. Unacknowledged messages are redelivered by the cloud-node.

```typescript
import { ack } from "@layr8/sdk";

client.handle(
  queryType,
  async (msg: Message): Promise<Message | null> => {
    const result = await executeQuery(msg);
    ack(msg as any); // explicitly acknowledge after success
    return {
      id: "", type: resultType, from: "", to: [],
      threadId: "", parentThreadId: "",
      body: result,
    };
  },
  { manualAck: true },
);
```

## Connection Lifecycle

### DID Assignment

If no `agentDid` is configured, the cloud-node assigns an ephemeral DID on connect:

```typescript
const client = new Layr8Client(logErrors(), {
  nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
  apiKey: "my-key",
});
await client.connect();

console.log(client.did); // "did:web:myorg:abc123" (assigned by node)
```

### Connection Resilience

The SDK automatically reconnects when the WebSocket connection drops (e.g., node restart, network interruption). Reconnection uses exponential backoff starting at 1 second, capped at 30 seconds.

During reconnection:
- `send()`, `request()`, and other operations throw `NotConnectedError` immediately — the SDK does not queue messages
- The `disconnect` event fires when the connection drops
- The `reconnect` event fires when the connection is restored
- `close()` stops the reconnect loop

```typescript
client.on("disconnect", (err: Error) => {
  console.log("disconnected:", err.message);
});

client.on("reconnect", () => {
  console.log("reconnected");
});
```

## Observability Hooks

For tools that need to surface raw DIDComm traffic (debugging, dashboards, MCP-style adapters that expose layr8 to other runtimes), the client emits events for every message it sends or receives. These fire alongside normal dispatch and don't change handler semantics.

```typescript
client.on("inbound", (msg: Message) => {
  console.log("← recv", msg.type, "from", msg.from);
});

client.on("outbound", (msg: Message) => {
  console.log("→ send", msg.type, "to", msg.to);
});
```

`inbound` fires after a message is successfully parsed, before it's routed to a handler or matched to a pending `request()`. `outbound` fires for every `send()`, `request()`, and handler auto-response.

### Default handler for unmatched types

When the cloud-node delivers a message whose type has no specific handler, the default behaviour is to fire `ErrorKind.NoHandler` via your error handler. To route those messages somewhere instead, register a default handler:

```typescript
client.handleDefault(async (msg: Message) => {
  console.log("unmatched:", msg.type);
  return null;
});
```

The cloud-node only delivers messages whose **protocol** the client has subscribed to (derived from `handle()` registrations). The default handler catches types within a subscribed protocol that lack a specific handler — it does not cause the client to subscribe to additional protocols.

## Message Context

Inbound messages include a `context` field with metadata from the cloud-node:

```typescript
client.handle(messageType, async (msg: Message) => {
  if (msg.context) {
    console.log("Recipient:", msg.context.recipient);
    console.log("Authorized:", msg.context.authorized);

    for (const cred of msg.context.senderCredentials) {
      console.log(`Sender credential: ${cred.name} (${cred.id})`);
    }
  }
  return null;
});
```

| Field | Type | Description |
|---|---|---|
| `recipient` | `string` | The DID that received this message |
| `authorized` | `boolean` | Whether the sender is authorized by the node's policy |
| `senderCredentials` | `Credential[]` | Verifiable credentials presented by the sender |

## Error Handling

### ErrorHandler (Required)

The `Layr8Client` constructor requires an `ErrorHandler` callback as its first argument. This ensures no SDK errors are silently dropped. The callback receives structured `SDKError` objects for parse failures, unhandled message types, handler exceptions, and server rejections.

```typescript
import { Layr8Client, logErrors } from "@layr8/sdk";
import type { ErrorHandler } from "@layr8/sdk";

// Use the built-in logger (writes to console.error)
const client = new Layr8Client(logErrors(), { ... });

// Or provide a custom handler
const onError: ErrorHandler = (err) => {
  metrics.increment(`sdk.error.${err.kind}`);
  logger.warn("SDK error", {
    kind: err.kind,
    messageId: err.messageId,
    type: err.type,
    cause: err.cause?.message,
  });
};
const client = new Layr8Client(onError, { ... });
```

### SDKError

`SDKError` is a structured error report passed to the `ErrorHandler`. It carries machine-readable context about what went wrong:

| Field | Type | Description |
|---|---|---|
| `kind` | `ErrorKind` | Category of the error |
| `messageId` | `string` | ID of the message that caused the error (if available) |
| `type` | `string` | DIDComm message type (if available) |
| `from` | `string` | Sender DID (if available) |
| `cause` | `Error \| null` | Underlying error |
| `raw` | `unknown` | Raw payload for parse failures |
| `timestamp` | `Date` | When the error occurred |

### ErrorKind

| Kind | Description |
|---|---|
| `ParseFailure` | Inbound message could not be parsed as DIDComm |
| `NoHandler` | No handler registered for the message type |
| `HandlerException` | A handler threw an exception |
| `ServerReject` | The server rejected a sent message |
| `TransportWrite` | Failed to write to the WebSocket connection |

### logErrors()

`logErrors()` returns a built-in `ErrorHandler` that logs every error to `console.error` with structured metadata. Use it as a sensible default:

```typescript
import { logErrors } from "@layr8/sdk";

const client = new Layr8Client(logErrors(), { ... });
```

### Problem Reports

When a handler throws an error, the SDK automatically sends a [DIDComm problem report](https://identity.foundation/didcomm-messaging/spec/#problem-reports) to the sender:

```typescript
client.handle(msgType, async (msg: Message) => {
  throw new Error("something went wrong"); // sends problem report
});
```

When `request()` receives a problem report as the response, it throws a `ProblemReportError`:

```typescript
import { ProblemReportError } from "@layr8/sdk";

try {
  const resp = await client.request(msg);
} catch (err) {
  if (err instanceof ProblemReportError) {
    console.log(`Remote error [${err.code}]: ${err.comment}`);
  }
}
```

### Connection Errors

Connection failures throw a `ConnectionError`:

```typescript
import { ConnectionError } from "@layr8/sdk";

try {
  await client.connect();
} catch (err) {
  if (err instanceof ConnectionError) {
    console.log(`Failed to connect to ${err.url}: ${err.reason}`);
  }
}
```

### Error Classes

| Error | Description |
|---|---|
| `NotConnectedError` | Operation attempted before `connect()` or after `close()` |
| `AlreadyConnectedError` | `handle()` called after `connect()` |
| `ClientClosedError` | `connect()` called on a closed client |
| `ProblemReportError` | Remote handler returned an error (`.code`, `.comment`) |
| `ConnectionError` | Failed to connect to cloud-node (`.url`, `.reason`) |

## W3C Verifiable Credentials

The SDK provides methods for signing, verifying, storing, listing, and retrieving [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model-2.0/). These operations use the cloud-node's REST API and the DID keys in the node's wallet.

### Sign a Credential

```typescript
import type { Credential } from "@layr8/sdk";

const cred: Credential = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: "urn:uuid:my-credential",
  type: ["VerifiableCredential"],
  issuer: client.did,
  credentialSubject: { id: "did:web:example:holder", name: "Alice" },
};

const signedJWT = await client.signCredential(cred);
```

Options: `{ issuerDid, format }`.

### Verify a Credential

```typescript
const verified = await client.verifyCredential(signedJWT);
console.log(verified.credential); // decoded credential claims
console.log(verified.headers);    // JWT headers (alg, kid, etc.)
```

Options: `{ verifierDid }`.

> **Note:** The verifier DID must have keys in the local node's wallet. Cross-node verification is not currently supported.

### Store, List, Get

```typescript
// Store a signed credential
const stored = await client.storeCredential(signedJWT);
console.log(stored.id); // storage ID

// List all stored credentials
const creds = await client.listCredentials();

// Retrieve by ID
const fetched = await client.getCredential(stored.id);
console.log(fetched.credential_jwt); // the original signed JWT
```

Store options: `{ holderDid, issuerDid, validUntil }`.
List options: `{ holderDid }`.

### Output Formats

The `format` option accepts: `"compact_jwt"` (default), `"json"`, `"jwt"`, `"enveloped"`.

## W3C Verifiable Presentations

Presentations wrap one or more signed credentials into a holder-signed envelope.

### Sign a Presentation

```typescript
const signedPres = await client.signPresentation([signedJWT], {
  nonce: "challenge-from-verifier",
});
```

Options: `{ holderDid, format, nonce }`.

### Verify a Presentation

```typescript
const verified = await client.verifyPresentation(signedPres);
console.log(verified.presentation); // decoded presentation claims
console.log(verified.headers);      // JWT headers
```

Options: `{ verifierDid }`.

## Examples

The [examples/](examples/) directory contains complete, runnable agents:

### Echo Agent

A minimal agent that echoes back any message it receives. Demonstrates request/response handlers with auto-ack, auto-thread correlation, and reconnection with backoff.

```bash
LAYR8_API_KEY=your-key npx tsx examples/echo-agent.ts
```

### Chat Client

An interactive chat client for DIDComm basic messaging. Demonstrates fire-and-forget `send()`, inbound message handling, `MessageContext` for sender credentials, and multi-recipient messaging.

```bash
LAYR8_API_KEY=your-key npx tsx examples/chat.ts did:web:friend:chat-agent
```

### Durable Handler

Persist-then-ack pattern: writes inbound messages to a JSON-lines file before acknowledging. If the process crashes before ack, the cloud-node redelivers. Demonstrates `manualAck` with zero external dependencies.

```bash
LAYR8_API_KEY=your-key npx tsx examples/durable-handler.ts
```

## Development

### Prerequisites

- Node.js 20+
- npm

### Scripts

```bash
npm test           # Run unit tests (vitest)
npm run test:watch # Run tests in watch mode
npm run build      # Compile TypeScript
```

## Architecture

The SDK is structured around a small set of types:

```
Layr8Client       → public API (connect, send, request, handle, close)
  ├── Config      → configuration with env var fallback
  ├── Message     → DIDComm v2 message envelope
  ├── Handler     → message type → handler function registry
  └── Channel     → WebSocket/Phoenix Channel transport
```

The transport layer implements the Phoenix Channel V2 wire protocol over WebSocket, including join negotiation, heartbeats, and message acknowledgment.

## License

Copyright Layr8 Inc. All rights reserved.
