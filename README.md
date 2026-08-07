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

The SDK also auto-adds the DIDComm problem report protocol (`https://didcomm.org/report-problem/2.0`), ensuring at least one protocol is always present. The cloud-node requires at least one protocol on join.

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

### MCP (Model Context Protocol) over DIDComm

Some Layr8 services expose an [MCP](https://modelcontextprotocol.io/) surface as
DIDComm request/reply: a request of type `${base}/<method>` carrying a JSON-RPC
2.0 body, answered by a `${base}/<method>-result` message. `client.mcp()` wraps
that pattern — the `${base}/…` type, the JSON-RPC envelope, unwrapping `result`,
and the protocol subscription — on top of `request()` (which correlates the
reply by its echoed `thread_id`).

```typescript
const client = new Layr8Client(logErrors(), { nodeUrl, apiKey, agentDid });

// Call mcp() BEFORE connect() (like handle()) — it registers the protocol
// subscription the node needs to deliver replies.
const mcp = client.mcp(); // default base: https://layr8.io/protocols/mcp/1.0
await client.connect();

const peer = mcp.peer("did:web:other-org:some-service");
await peer.initialize();
const tools = await peer.listTools();                       // → [{ name, ... }]
const result = await peer.callTool("create_workflow", {     // MCP tools/call
  name: "wf",
  steps: [/* … */],
});
// low-level: any method, returns the JSON-RPC `result` (throws McpError on error)
await peer.call("tools/call", { name: "…", arguments: { /* … */ } });
```

`mcp(base?)` returns an `McpBinding`; `binding.peer(did)` returns an `McpPeer`
(`.call` / `.callTool` / `.listTools` / `.initialize`). A JSON-RPC `error`
reply throws `McpError` (`.code`, `.message`, `.data`). `mcp()` must be called
before `connect()` and is idempotent per base.

## Configuration

Configuration can be set explicitly or via environment variables. Environment variables are used as fallbacks when the corresponding field is empty or undefined.

| Field | Environment Variable | Required | Description |
|---|---|---|---|
| `nodeUrl` | `LAYR8_NODE_URL` | Yes | WebSocket URL of the cloud-node |
| `apiKey` | `LAYR8_API_KEY` | Yes | API key for authentication |
| `agentDid` | `LAYR8_AGENT_DID` | Yes | Agent DID identity |
| `attachGrants` | `LAYR8_ATTACH_GRANTS` | No | Attach covering Verifiable Grants to outbound messages (default `true`) — see [Verifiable Grants](#verifiable-grants) |
| `grantCacheMs` | `LAYR8_GRANT_CACHE_MS` | No | How long held grants are cached before re-reading (default `60000`) |
| `grantReadTimeoutMs` | `LAYR8_GRANT_READ_TIMEOUT_MS` | No | Deadline on the grant read that precedes a send (default `2000`) — see [If the node stops answering](#if-the-node-stops-answering) |
| `restTimeoutMs` | `LAYR8_REST_TIMEOUT_MS` | No | Deadline on every credential/presentation REST call (default `30000`, `0` disables) — see [Deadlines on the credential APIs](#deadlines-on-the-credential-apis) |
| `onGrantMiss` | — | No | Called when the node denies a message you sent with no grant attached |

`agentDid` is required — set it explicitly or via `LAYR8_AGENT_DID`. It's the DID your agent connects as and the address other agents use to message it; the cloud-node rejects a connection that doesn't specify one. Retrieve the active DID at runtime with `client.did`.

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

## Verifiable Grants

The cloud-node requires a Verifiable Grant for any message its policy does not
allow outright. **The SDK attaches them for you**, on every outbound path —
`send`, `request`, and a handler's reply.

You do not configure anything. On the first send the SDK reads the grants your
agent DID holds, keeps the covering ones on the message, and caches the set for
`grantCacheMs`.

```typescript
// Nothing to do — the grants covering this message are attached.
await client.send({
  to: ["did:web:example.com:mcp:gmail:gmail"],
  type: "https://layr8.io/protocols/mcp/1.0/tools-call",
  body: { method: "tools/call", params: { name: "search_emails" } },
});
```

### When a call is denied

A denial reads `Authorization requirements not met` and names the grant the node
could not find — which sends people to check a grant that is fine. The sender is
the only party that knows whether a credential was ever put on the wire, so wire
up `onGrantMiss` and the next such incident is one line instead of a day:

```typescript
const client = new Layr8Client(logErrors(), {
  onGrantMiss: ({ to, type, denialCode, error, capped }) => {
    if (error) console.warn("could not read grants:", error);
    else if (capped) console.warn(`only ${capped.attached} of ${capped.covering} grants fit`);
    else console.warn(`${denialCode}: sent ${type} to ${to} with NO grant attached`);
  },
});
```

It fires on the **denial**, not on every send — most DIDComm traffic (discovery,
trust-ping, problem reports) needs no grant at all, and a diagnostic that fires
constantly is one nobody reads when it matters. Two things are announced
immediately instead, because neither is ever a normal outcome: a failure to
*read* the grants (every subsequent send is flying blind), and a covering set
large enough that some of it had to be left off the message.

### If the node stops answering

The credential read that precedes a send is bounded by `grantReadTimeoutMs`
(2s by default, env `LAYR8_GRANT_READ_TIMEOUT_MS`). On a timeout the message goes
out **unattached** and `onGrantMiss` is called with the error — the node is the
authority on whether that message needed a grant, and refusing to send would take
down calls that never did.

The deadline is not optional politeness. The read runs inside the per-channel
write chain, which is what keeps outbound writes in call order, so an unbounded
read would stall every later send on that channel — including ones that carry
their own attachments and never consult the wallet.

The same applies to every other call this SDK makes over HTTP — see
[Deadlines on the credential APIs](#deadlines-on-the-credential-apis).

### Deadlines on the credential APIs

Every credential and presentation call — `signCredential`, `verifyCredential`,
`storeCredential`, `listCredentials`, `getCredential`, `signPresentation`,
`verifyPresentation` — is bounded by `restTimeoutMs` (**30s by default**, env
`LAYR8_REST_TIMEOUT_MS`).

There is a default because the alternative is not "waiting". Node's
`http.request` has no timeout of its own, so a node that accepts the TCP
connection and then goes quiet leaves the returned promise pending **forever**:
it never resolves, never rejects, and never gives you the one thing you could act
on — the knowledge that the answer is not coming.

**The deadline is on socket inactivity, not on total elapsed time.** A peer that
keeps sending bytes keeps resetting it. That is what makes it able to catch a
silent connection at all — but it also means the node's own signing time counts
against it, because nothing flows on the wire while the node computes. A sign
that is merely slow looks exactly like a node that has stopped.

So each of those methods takes a per-call `timeoutMs` that overrides the default:

```typescript
// This issuer signs a large credential on a busy node: give it room.
const signed = await client.signCredential(credential, { timeoutMs: 120_000 });

// No deadline at all for this one call.
const listed = await client.listCredentials({ timeoutMs: 0 });

// Or lift it for the whole client (`0` means unbounded, as it did before).
const client = new Layr8Client(logErrors(), { restTimeoutMs: 60_000 });
```

`0` disables the deadline; leaving `timeoutMs` out (or `undefined`) uses the
client default. Raise it on the call you know is slow rather than removing it
everywhere — an unbounded call should be something you asked for, not something
you got by forgetting.

### A grant issued just now

Held grants are cached for `grantCacheMs` (60s by default), so a grant minted
seconds ago is invisible until the cache lapses. If your agent has just been told
it was granted something, say so:

```typescript
client.refreshGrants();          // this agent's DID
client.refreshGrants(otherDid);  // a DID joined with joinDid()
```

### Turning it off

`attachGrants: false` (or `LAYR8_ATTACH_GRANTS=false`) stops the SDK reading or
attaching anything; you then compose `attachments` yourself. Attachments you
supply are never displaced — a message that already carries attachments is sent
untouched.

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

### Agent DID

Your agent's DID is its identity on the network — the address other agents use to reach it. Configure it via `agentDid` (or the `LAYR8_AGENT_DID` env var); connecting without one is rejected by the cloud-node. Read the active DID back at runtime with `client.did`:

```typescript
const client = new Layr8Client(logErrors(), {
  nodeUrl: "ws://localhost:4000/plugin_socket/websocket",
  apiKey: "my-key",
  agentDid: "did:web:myorg:my-agent",
});
await client.connect();

console.log(client.did); // "did:web:myorg:my-agent"
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

`handleDefault` runs with auto-ack only; `manualAck` is not supported on the fallback path. Use `handle(type, fn, { manualAck: true })` for types that need durable processing.

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
Get options: `{ timeoutMs }`.

Every one of these also takes `timeoutMs` — see
[Deadlines on the credential APIs](#deadlines-on-the-credential-apis).

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

Both also take `timeoutMs` — see
[Deadlines on the credential APIs](#deadlines-on-the-credential-apis). Signing a
presentation is the same kind of silent compute on the node that signing a
credential is.

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

## Compat Testing

The `compat/` directory implements cross-language compatibility testing for the [compat-suite](https://github.com/layr8/compat-suite) orchestrator.

### Structure

```
compat/
├── scenarios/       # Core scenario logic (echo, pass, wildcard, disconnected)
├── tests/           # Layer 1: vitest tests with mock Phoenix server
├── bin/             # Layer 2: CLI adapter for compat-suite orchestrator
├── Dockerfile       # Builds ghcr.io/layr8/node-sdk/compat:{version}
└── cloud-nodes.json # Supported cloud-node version declaration
```

### Running Locally

```bash
npm run compat:test
```

### Adding a Scenario

1. Create `compat/scenarios/{name}.ts` exporting `runReceiver(ctx, onReady?)` and `runSender(ctx)`
2. Create `compat/tests/{name}.test.ts` using the `MockPhoenixServer`
3. The CLI auto-discovers scenarios from the `scenarios/` directory

### CI Flow

1. Build + unit tests
2. Layer 1 compat tests (mock server, no Docker)
3. Publish SDK to npm
4. Build + push compat image to ghcr.io
5. Trigger compat-suite gate (cross-language matrix)

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
