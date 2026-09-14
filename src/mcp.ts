import type { Layr8Client } from "./client.js";

/**
 * MCP (Model Context Protocol) over Layr8 DIDComm.
 *
 * A growing set of Layr8 services (Loom is the first) expose an MCP surface as
 * DIDComm request/reply: a request of type `${base}/<method>` carrying a
 * JSON-RPC 2.0 body, answered by a `${base}/<method>-result` message whose body
 * is the JSON-RPC response. The reply echoes the request's DIDComm `thread_id`,
 * so `Layr8Client.request()` correlates it automatically — this helper just
 * removes the boilerplate (protocol subscription, the `${base}/…` type, the
 * JSON-RPC envelope, and unwrapping `result` / throwing on `error`).
 *
 * Usage (note: `client.mcp(...)` must be called BEFORE `connect()`, like
 * `handle()`, because it registers the protocol subscription the node needs to
 * deliver replies):
 *
 *   const mcp = client.mcp();            // default base, registers subscription
 *   await client.connect();
 *   const loom = mcp.peer(loomDid);
 *   await loom.initialize();
 *   const tools = await loom.listTools();
 *   await loom.callTool("create_workflow", { name, steps });
 */

/** The default MCP protocol base (mcp/1.0). */
export const DEFAULT_MCP_BASE = "https://layr8.io/protocols/mcp/1.0";

/** Thrown when a peer answers a call with a JSON-RPC `error` object. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Options for a single MCP call. */
export interface McpCallOptions {
  /** AbortSignal for timeout/cancellation (forwarded to `request()`). */
  signal?: AbortSignal;
}

/** The DIDComm type for an MCP method: `tools/call` → `${base}/tools-call`. */
function typeFor(base: string, method: string): string {
  return `${base}/${method.split("/").join("-")}`;
}

/**
 * A peer-bound MCP caller. Obtained via `client.mcp().peer(did)`.
 * Each `call()` sends one JSON-RPC request and returns its `result`.
 */
export class McpPeer {
  private nextId = 0;

  constructor(
    /** @internal */ private readonly client: Layr8Client,
    /** The peer DID this caller targets. */
    readonly did: string,
    /** The MCP protocol base. */
    readonly base: string,
  ) {}

  /**
   * Call an MCP `method` on the peer with optional `params`, and return the
   * JSON-RPC `result`. Throws `McpError` if the peer answers with an `error`,
   * or a request error (timeout/ProblemReport) from `request()`.
   */
  async call<T = unknown>(
    method: string,
    params?: unknown,
    opts?: McpCallOptions,
  ): Promise<T> {
    const id = ++this.nextId;
    const reply = await this.client.request(
      {
        to: [this.did],
        type: typeForMethod(this.base, method),
        body: {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        },
      },
      opts?.signal ? { signal: opts.signal } : undefined,
    );

    const raw = (reply as { bodyRaw?: unknown }).bodyRaw ?? reply.body;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new McpError(-32603, `peer returned a non-JSON-RPC body: ${JSON.stringify(raw ?? null)}`);
    }
    const body = raw as {
      result?: T;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (body.error !== null && typeof body.error === "object") {
      const { code, message, data } = body.error;
      if (typeof code !== "number" || typeof message !== "string") {
        // An error object without a numeric code and a string message is not a
        // JSON-RPC error; inventing -32603 and an empty message would state a
        // failure the peer did not report.
        throw new McpError(-32603, `peer returned a malformed JSON-RPC error: ${JSON.stringify(body)}`);
      }
      throw new McpError(code, message, data);
    }
    if (!("result" in body)) {
      // A reply with neither `result` nor `error` is not a JSON-RPC response.
      // Returning `undefined` would read as a peer that answered with nothing,
      // which is a success value nobody measured. The Python, Go and Elixir
      // SDKs refuse the same reply.
      throw new McpError(-32603, `peer returned neither result nor error: ${JSON.stringify(body)}`);
    }
    return body.result as T;
  }

  /** Convenience for MCP `tools/call`. */
  callTool<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<T> {
    return this.call<T>("tools/call", { name, arguments: args ?? {} }, opts);
  }

  /** Convenience for MCP `tools/list`; returns the `tools` array. */
  async listTools(
    opts?: McpCallOptions,
  ): Promise<Array<{ name: string; [k: string]: unknown }>> {
    const r = await this.call<{ tools?: Array<{ name: string }> }>(
      "tools/list",
      undefined,
      opts,
    );
    return r?.tools ?? [];
  }

  /** Convenience for MCP `initialize`. */
  initialize(
    clientInfo?: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<unknown> {
    return this.call(
      "initialize",
      { clientInfo: clientInfo ?? { name: "@layr8/sdk" } },
      opts,
    );
  }
}

/** A base-bound MCP binding. Call `peer(did)` to get a caller. */
export class McpBinding {
  constructor(
    /** @internal */ private readonly client: Layr8Client,
    /** The MCP protocol base this binding subscribed to. */
    readonly base: string,
  ) {}

  /** A caller bound to `did` on this binding's protocol base. */
  peer(did: string): McpPeer {
    return new McpPeer(this.client, did, this.base);
  }
}

// Kept as a named export so the type mapping is testable/documented.
export function typeForMethod(base: string, method: string): string {
  return typeFor(base, method);
}
