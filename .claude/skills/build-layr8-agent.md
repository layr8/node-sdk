---
name: build-layr8-agent
description: Use when building a Node.js/TypeScript agent for the Layr8 platform. Covers the full SDK API — config, handlers, messaging, error handling, and DIDComm conventions.
---

# Building Layr8 Agents with the Node.js SDK

Full documentation: https://docs.layr8.io/reference/node-sdk

## Import

```typescript
import { Layr8Client, unmarshalBody, ack } from "@layr8/sdk";
import type { Message } from "@layr8/sdk";
```

The package is ESM-only (`"type": "module"`). Requires Node.js 20+.

## Config

```typescript
const client = new Layr8Client({
    nodeUrl: "ws://mynode.localhost/plugin_socket/websocket",
    apiKey: "my_api_key",
    agentDid: "did:web:mynode.localhost:my-agent",
});
```

All fields fall back to environment variables if empty/undefined:
- `nodeUrl`  → `LAYR8_NODE_URL`
- `apiKey`   → `LAYR8_API_KEY`
- `agentDid` → `LAYR8_AGENT_DID`

`agentDid` is optional — if omitted, the node assigns an ephemeral DID on connect.

## Lifecycle

```
new Layr8Client → handle (register handlers) → connect → ... → close
```

- `handle` must be called BEFORE `connect` — throws `AlreadyConnectedError` after.
- `connect()` establishes WebSocket and joins the Phoenix Channel. Returns a Promise.
- `close()` sends `phx_leave` and shuts down gracefully. Returns a Promise.
- `did` (getter) returns the agent's DID (explicit or node-assigned).

## Registering Handlers

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

Handler return values:
- `Message` → send response to sender (auto-fills `id`, `from`, `to`, `threadId`)
- `null` → no response (fire-and-forget inbound)
- Thrown error → send DIDComm problem report to sender

The protocol base URI is derived automatically from the message type
(last path segment removed) and registered with the node on connect.

## Sending Messages

### Fire-and-forget

```typescript
await client.send({
    type: "https://didcomm.org/basicmessage/2.0/message",
    to: ["did:web:other-node:agent"],
    body: { content: "Hello!" },
});
```

`send()` accepts `Partial<Message>` — only `type`, `to`, and `body` are required.

### Request/Response

```typescript
const resp = await client.request(
    {
        type: "https://layr8.io/protocols/echo/1.0/request",
        to: ["did:web:other-node:agent"],
        body: { message: "ping" },
    },
    { signal: AbortSignal.timeout(5_000) },
);

const result = unmarshalBody<EchoResponse>(resp as any);
// result is the correlated response (matched by thread ID)
```

## Message Structure

```typescript
interface Message {
    id: string;             // auto-generated if empty
    type: string;           // DIDComm message type URI
    from: string;           // auto-filled with agent DID
    to: string[];           // recipient DIDs
    threadId: string;       // auto-generated for request
    parentThreadId: string; // set via parentThread option
    body: unknown;          // serialized to JSON
    context?: MessageContext; // populated on inbound messages
}
```

### Inbound Message Context

```typescript
if (msg.context) {
    msg.context.authorized;        // boolean — node authorization result
    msg.context.recipient;         // string — recipient DID
    msg.context.senderCredentials; // Credential[] — {id, name}
}
```

## Options

### Manual Ack

By default, messages are auto-acked before the handler runs.
Use `manualAck` to control ack timing (e.g., ack only after DB write):

```typescript
import { ack } from "@layr8/sdk";

client.handle(msgType, handler, { manualAck: true });

// Inside handler:
ack(msg as any); // explicitly ack after processing
```

### Request Options

```typescript
interface RequestOptions {
    parentThread?: string;  // parent thread ID for nested conversations
    signal?: AbortSignal;   // abort/timeout control
}

const resp = await client.request(msg, {
    parentThread: "parent-thread-id",
    signal: AbortSignal.timeout(5_000),
});
```

## Error Handling

### Problem Reports

When a remote handler throws, `request` throws `ProblemReportError`:

```typescript
import { ProblemReportError } from "@layr8/sdk";

try {
    const resp = await client.request(msg);
} catch (err) {
    if (err instanceof ProblemReportError) {
        console.log(`remote error [${err.code}]: ${err.comment}`);
    }
}
```

### Error Classes

- `NotConnectedError` — `send`/`request` called before `connect`
- `AlreadyConnectedError` — `handle` called after `connect`
- `ClientClosedError` — `connect` called after `close`
- `ConnectionError` — failed to connect to node (`.url`, `.reason`)

```typescript
import { ConnectionError } from "@layr8/sdk";

try {
    await client.connect();
} catch (err) {
    if (err instanceof ConnectionError) {
        console.log(`failed to connect to ${err.url}: ${err.reason}`);
    }
}
```

## Connection Events

```typescript
client.on("disconnect", (err: Error) => {
    console.log("connection lost:", err.message);
});
client.on("reconnect", () => {
    console.log("reconnected");
});
```

Note: `disconnect` fires only on unexpected drops, not on `close()`.

## DID and Protocol Conventions

### DID Format

```
did:web:{node-domain}:{agent-path}
```

Examples:
- `did:web:alice-test.localhost:my-agent`
- `did:web:earth.node.layr8.org:echo-service`

### Protocol URI Format

```
https://layr8.io/protocols/{name}/{version}/{message-type}
```

The base URI (without the last segment) is the protocol identifier.
Example: `https://layr8.io/protocols/echo/1.0/request` → protocol `https://layr8.io/protocols/echo/1.0`

### Standard Protocols

- Basic message: `https://didcomm.org/basicmessage/2.0/message`
- Problem report: `https://didcomm.org/report-problem/2.0/problem-report`

## Complete Example: Echo Agent

```typescript
import { Layr8Client, unmarshalBody } from "@layr8/sdk";
import type { Message } from "@layr8/sdk";

interface EchoRequest {
    message: string;
}

interface EchoResponse {
    echo: string;
}

const client = new Layr8Client({});

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
            body: { echo: body.message } satisfies EchoResponse,
        };
    },
);

await client.connect();
console.log(`echo agent running as ${client.did}`);

process.on("SIGINT", async () => {
    await client.close();
    process.exit(0);
});
```

## Complete Example: Request/Response Client

```typescript
import { Layr8Client, unmarshalBody, ProblemReportError } from "@layr8/sdk";
import type { Message } from "@layr8/sdk";

interface EchoRequest {
    message: string;
}

interface EchoResponse {
    echo: string;
}

const client = new Layr8Client({});

// Must register the protocol even if not handling inbound
client.handle(
    "https://layr8.io/protocols/echo/1.0/request",
    async (_msg: Message) => null,
);

await client.connect();

try {
    const resp = await client.request(
        {
            type: "https://layr8.io/protocols/echo/1.0/request",
            to: ["did:web:other-node:echo-agent"],
            body: { message: "Hello!" } satisfies EchoRequest,
        },
        { signal: AbortSignal.timeout(5_000) },
    );

    const result = unmarshalBody<EchoResponse>(resp as any);
    console.log(`response: ${result.echo}`);
} catch (err) {
    if (err instanceof ProblemReportError) {
        console.error(`remote error [${err.code}]: ${err.comment}`);
    } else {
        throw err;
    }
} finally {
    await client.close();
}
```

## More Examples

See the `examples/` directory in the SDK repo for complete working agents:
- `examples/echo-agent.ts` — minimal echo service
- `examples/chat.ts` — interactive chat client
- `examples/durable-handler.ts` — persist-then-ack with JSON-lines
