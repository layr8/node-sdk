import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { Layr8Client, McpError, DEFAULT_MCP_BASE, logErrors } from "../src/index.js";
import type { ErrorHandler } from "../src/index.js";
import { ephemeralServer, readyUrl } from "./helpers/mock-ws-server.js";

const discardErrors: ErrorHandler = () => {};

/** Minimal Phoenix Channel V2 mock (mirrors tests/client.test.ts). */
class MockPhoenixServer {
  private wss: WebSocketServer;
  private client: WS | null = null;
  onMsg:
    | ((msg: { joinRef: string | null; ref: string | null; topic: string; event: string; payload: unknown }) => void)
    | null = null;

  constructor() {
    this.wss = ephemeralServer();
    this.wss.on("connection", (ws: WS) => {
      this.client = ws;
      ws.on("message", (data: Buffer) => {
        const arr = JSON.parse(data.toString()) as unknown[];
        this.onMsg?.({
          joinRef: arr[0] as string | null,
          ref: arr[1] as string | null,
          topic: arr[2] as string,
          event: arr[3] as string,
          payload: arr[4],
        });
      });
    });
  }

  /** Resolve with the ws:// URL once the kernel has assigned a port. */
  ready(): Promise<string> {
    return readyUrl(this.wss);
  }

  sendToClient(joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown): void {
    if (this.client && this.client.readyState === WS.OPEN) {
      this.client.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

const MY = "did:web:alice";
const PEER = "did:web:bob";

let server: MockPhoenixServer;

/**
 * Server that joins ok and, for each outbound `message`, acks then replies with
 * a `${BASE}/<method>-result` DIDComm message echoing the outbound `thid` and
 * a JSON-RPC body produced by `respond(outboundJsonRpc)`.
 */
async function mcpServer(respond: (rpc: any) => { result?: unknown; error?: unknown }): Promise<string> {
  server = new MockPhoenixServer();
  const wsUrl = await server.ready();
  server.onMsg = (msg) => {
    if (msg.event === "phx_join") {
      server.sendToClient(msg.ref, msg.ref, msg.topic, "phx_reply", { status: "ok", response: { did: "did:web:node:test" } });
      return;
    }
    if (msg.ref) server.sendToClient(null, msg.ref, msg.topic, "phx_reply", { status: "ok", response: {} });
    if (msg.event === "message") {
      const out = msg.payload as { thid: string; from: string; type: string; body: any };
      const suffix = out.type.slice(out.type.lastIndexOf("/") + 1); // e.g. "tools-list"
      const rpc = respond(out.body);
      server.sendToClient(null, null, `plugins:${MY}`, "message", {
        plaintext: {
          id: "resp-1",
          type: `${DEFAULT_MCP_BASE}/${suffix}-result`,
          from: PEER,
          to: [out.from],
          thid: out.thid,
          body: { jsonrpc: "2.0", id: out.body.id, ...rpc },
        },
      });
    }
  };
  return wsUrl;
}

describe("client.mcp()", () => {
  afterEach(async () => { if (server) await server.close(); });

  it("call() sends the right type + JSON-RPC and unwraps result", async () => {
    let sawType = "";
    let sawMethod = "";
    const wsUrl = await mcpServer((rpc) => {
      sawMethod = rpc.method;
      return { result: { tools: [{ name: "create_workflow" }, { name: "run_workflow" }] } };
    });
    // capture the outbound type
    const origOnMsg = server.onMsg!;
    server.onMsg = (m) => { if (m.event === "message") sawType = (m.payload as any).type; origOnMsg(m); };

    const client = new Layr8Client(discardErrors, { nodeUrl: wsUrl, apiKey: "k", agentDid: MY });
    const mcp = client.mcp(); // BEFORE connect — registers the subscription
    await client.connect();

    const tools = await mcp.peer(PEER).listTools();
    expect(tools.map((t) => t.name)).toEqual(["create_workflow", "run_workflow"]);
    expect(sawType).toBe(`${DEFAULT_MCP_BASE}/tools-list`);
    expect(sawMethod).toBe("tools/list");
    await client.close();
  });

  it("callTool() wraps name/arguments and returns result", async () => {
    let sawParams: any;
    const wsUrl = await mcpServer((rpc) => { sawParams = rpc.params; return { result: { content: [{ type: "text", text: "ok" }] } }; });
    const client = new Layr8Client(discardErrors, { nodeUrl: wsUrl, apiKey: "k", agentDid: MY });
    const mcp = client.mcp();
    await client.connect();

    const r = await mcp.peer(PEER).callTool("create_workflow", { name: "wf", steps: [] });
    expect((r as any).content[0].text).toBe("ok");
    expect(sawParams).toEqual({ name: "create_workflow", arguments: { name: "wf", steps: [] } });
    await client.close();
  });

  it("throws McpError on a JSON-RPC error reply", async () => {
    const wsUrl = await mcpServer(() => ({ error: { code: -32001, message: "not authorized" } }));
    const client = new Layr8Client(discardErrors, { nodeUrl: wsUrl, apiKey: "k", agentDid: MY });
    const mcp = client.mcp();
    await client.connect();

    await expect(mcp.peer(PEER).call("tools/call", { name: "bash" })).rejects.toMatchObject({
      name: "McpError",
      code: -32001,
      message: "not authorized",
    });
    await client.close();
  });

  it("mcp() throws after connect() (must be pre-connect, like handle())", async () => {
    const wsUrl = await mcpServer(() => ({ result: {} }));
    const client = new Layr8Client(discardErrors, { nodeUrl: wsUrl, apiKey: "k", agentDid: MY });
    client.mcp(); // ok before connect
    await client.connect();
    expect(() => client.mcp()).toThrow();
    await client.close();
  });

  it("is idempotent per base (repeat mcp() does not double-register)", async () => {
    const client = new Layr8Client(discardErrors, { nodeUrl: "ws://127.0.0.1:1/x", apiKey: "k", agentDid: MY });
    expect(() => { client.mcp(); client.mcp(); }).not.toThrow(); // second call must not throw "already registered"
  });
});
