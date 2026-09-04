import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { WebSocketServer, WebSocket as WS } from "ws";
import { Layr8Client, mediation, MEDIATION_DELIVERY_TYPE, postDidcomm, RESTError } from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import type { Attachment, ErrorHandler } from "../src/index.js";

const discard: ErrorHandler = () => {};

/** A tiny HTTP stub node. `respond(req)` → { status, body }. */
function stubHttp(
  respond: (req: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }) => { status: number; body: string },
): Promise<{ port: number; seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>; close: () => Promise<void> }> {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(r);
      const { status, body } = respond(r);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const jwe = (tag: string) => `{"protected":"p","ciphertext":"${tag}"}`;
const att = (id: string, text: string): Attachment => ({ id, data: { base64: Buffer.from(text).toString("base64url") } });

describe("config", () => {
  afterEach(() => {
    delete process.env.LAYR8_MEDIATOR_DID;
    delete process.env.LAYR8_MEDIATOR_LIVE;
    delete process.env.LAYR8_DIDCOMM_URL;
  });

  it("resolves mediator fields from config and env", () => {
    const base = { nodeUrl: "wss://n.example/plugin_socket/websocket", apiKey: "k" };
    let cfg = resolveConfig({ ...base, mediator: "did:web:n.example:agents:m" });
    expect(cfg.mediator).toBe("did:web:n.example:agents:m");
    expect(cfg.mediatorLive).toBe(true);
    expect(cfg.didcommUrl).toBeNull();

    process.env.LAYR8_MEDIATOR_DID = "did:web:n.example:agents:env";
    process.env.LAYR8_MEDIATOR_LIVE = "false";
    process.env.LAYR8_DIDCOMM_URL = "https://ingress.example/didcomm";
    cfg = resolveConfig(base);
    expect(cfg.mediator).toBe("did:web:n.example:agents:env");
    expect(cfg.mediatorLive).toBe(false);
    expect(cfg.didcommUrl).toBe("https://ingress.example/didcomm");

    expect(resolveConfig({ ...base, mediator: "  " }).mediator).toBeNull();
  });
});

describe("client wiring", () => {
  it("exposes mediator and didcommUrl and subscribes to messagepickup on join", async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const wss = new WebSocketServer({ port });
    let joinPayload: any = null;
    wss.on("connection", (ws: WS) => {
      ws.on("message", (data: Buffer) => {
        const [joinRef, ref, topic, event, payload] = JSON.parse(data.toString());
        if (event === "phx_join") {
          joinPayload = payload;
          ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: { did: "did:web:n:a" } }]));
        } else if (ref) {
          ws.send(JSON.stringify([null, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        }
      });
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new Layr8Client(discard, {
      nodeUrl: `ws://127.0.0.1:${port}/plugin_socket/websocket`,
      apiKey: "k",
      agentDid: "did:web:n:a",
      mediator: "did:web:n:m",
      didcommUrl: "http://127.0.0.1:1/didcomm",
    });
    expect(client.mediator).toBe("did:web:n:m");
    expect(client.didcommUrl).toBe("http://127.0.0.1:1/didcomm");

    // Bootstrap runs in the background after connect and will fail against
    // this mock (no mediator answers); the error handler absorbs it.
    await client.connect();
    // Both mediation reply legs are bound at join, so the coordinate-mediation
    // grant is delivered even when the node does not negotiate reply_protocol/1.
    expect(joinPayload.payload_types).toContain("https://didcomm.org/messagepickup/3.0");
    expect(joinPayload.payload_types).toContain("https://didcomm.org/coordinate-mediation/3.0");
    await client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("an unmediated client derives didcommUrl from the node url and registers nothing", () => {
    const client = new Layr8Client(discard, { nodeUrl: "wss://n.example/plugin_socket/websocket", apiKey: "k", agentDid: "did:web:n:a" });
    expect(client.mediator).toBeNull();
    expect(client.didcommUrl).toBe("https://n.example/didcomm");
  });
});

describe("pure helpers", () => {
  it("ownRegistered accepts success and no_change for the agent's DID only", () => {
    expect(mediation.ownRegistered([{ recipient_did: "did:a", result: "success" }], "did:a")).toBe(true);
    expect(mediation.ownRegistered([{ recipient_did: "did:a", result: "no_change" }], "did:a")).toBe(true);
    expect(mediation.ownRegistered([{ recipient_did: "did:a", result: "client_error" }], "did:a")).toBe(false);
    expect(mediation.ownRegistered([{ recipient_did: "did:b", result: "success" }], "did:a")).toBe(false);
    expect(mediation.ownRegistered("nope", "did:a")).toBe(false);
  });

  it("ciphertext decodes base64url and rejects the rest", () => {
    expect(mediation.ciphertext(att("1", "abc"))?.toString()).toBe("abc");
    expect(mediation.ciphertext({ id: "2", data: { json: {} } })).toBeNull();
    expect(mediation.ciphertext({ id: "3", data: { base64: "" } })).toBeNull();
  });

  it("mediatorPath keeps the DID verbatim", () => {
    expect(mediation.mediatorPath("did:web:h:agents:a")).toBe("/api/v1/dids/did:web:h:agents:a/mediator");
  });

  it("MEDIATION_DELIVERY_TYPE is the pickup delivery type", () => {
    expect(MEDIATION_DELIVERY_TYPE).toBe("https://didcomm.org/messagepickup/3.0/delivery");
  });
});

describe("against a stub node", () => {
  it("declare PUTs the routing_did with the api key; undeclare DELETEs", async () => {
    const stub = await stubHttp((r) =>
      r.url === "/api/v1/dids/did:web:h:agents:a/mediator"
        ? { status: r.method === "DELETE" ? 204 : 200, body: r.method === "DELETE" ? "" : JSON.stringify({ did: "did:web:h:agents:a", routing_did: "did:web:h:agents:m" }) }
        : { status: 404, body: JSON.stringify({ error: "nope" }) },
    );
    const client = new Layr8Client(discard, { nodeUrl: `ws://127.0.0.1:${stub.port}/plugin_socket/websocket`, apiKey: "secret-key", agentDid: "did:web:h:agents:a" });

    expect(await mediation.declare(client, "did:web:h:agents:m")).toEqual({ ok: true });
    expect(stub.seen[0].method).toBe("PUT");
    expect(stub.seen[0].headers["x-api-key"]).toBe("secret-key");
    expect(JSON.parse(stub.seen[0].body)).toEqual({ routing_did: "did:web:h:agents:m" });

    expect(await mediation.undeclare(client)).toEqual({ ok: true });
    expect(stub.seen[1].method).toBe("DELETE");
    await stub.close();
  });

  it("reinject posts the decoded ciphertext to /didcomm and only reports what went in", async () => {
    const stub = await stubHttp((r) =>
      r.body.includes('"ciphertext":"bad"') ? { status: 500, body: JSON.stringify({ error: "boom" }) } : r.url === "/didcomm" ? { status: 202, body: "" } : { status: 404, body: "" },
    );
    const client = new Layr8Client(discard, { nodeUrl: `ws://127.0.0.1:${stub.port}/plugin_socket/websocket`, apiKey: "k", agentDid: "did:web:h:agents:a" });

    const atts: Attachment[] = [att("m1", jwe("one")), att("m2", jwe("bad")), { id: "m3", data: { json: {} } }, att("m4", jwe("four"))];
    expect(await mediation.reinject(client, atts)).toEqual({ ok: ["m1", "m4"], failed: ["m2", "m3"] });

    expect(stub.seen[0].url).toBe("/didcomm");
    expect(stub.seen[0].headers["content-type"]).toBe("application/didcomm-encrypted+json");
    expect(stub.seen[0].headers["x-api-key"]).toBeUndefined();
    expect(stub.seen[0].body).toBe(jwe("one"));
    await stub.close();
  });

  it("postDidcomm rejects non-2xx with a RESTError", async () => {
    const stub = await stubHttp(() => ({ status: 403, body: JSON.stringify({ error: "denied" }) }));
    await expect(postDidcomm(`http://127.0.0.1:${stub.port}/didcomm`, "{}")).rejects.toBeInstanceOf(RESTError);
    await stub.close();
  });
});
