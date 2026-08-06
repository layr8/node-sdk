// Grants reach the WIRE, not just the wallet.
//
// `wallet.test.ts` proves the selection. This proves the wiring, which is the
// half that has been wrong elsewhere in this system: a fix applied to `send` and
// not to `request`, or an attachment built in the right shape and never put on
// the frame. Asserting the code "looks like" it attaches is not the same claim.
//
// The credential below is a REAL grant, read from a live node — top-level claims
// with no `vc` wrapper, a `grant.tools` allowlist, an MCP `tools-call` scope
// bound to one resource. Its host names are rewritten to `example.com` because
// this repo is public; nothing else about it is edited, so the parser is
// exercised against the shape the node actually stores rather than one invented
// to match the parser.
//
// The fake node serves BOTH the WebSocket and the credential REST endpoint on
// one port, because that is the relationship the client assumes: it derives the
// REST base from the socket URL. A test with two ports would pass while the
// derivation was wrong.

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Layr8Client, type ErrorHandler } from "../src/index.js";

const discard: ErrorHandler = () => {};

const AGENT = "did:web:example.com:agents:myclaude";
const RESOURCE = "did:web:example.com:mcp:gmail-stdio:gmail-stdio";
const MCP_CALL = "https://layr8.io/protocols/mcp/1.0/tools-call";

/** A real VG, verbatim but for host names. Claims live at the payload's top level. */
const REAL_GRANT_CLAIMS = {
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://layr8.io/contexts/grant/v1",
  ],
  id: "urn:uuid:vg-mcp-9bde58e9-96fc-40f9-b719-2d3d99ac37e3",
  jti: "urn:uuid:vg-mcp-9bde58e9-96fc-40f9-b719-2d3d99ac37e3",
  type: ["VerifiableCredential", "VerifiableGrant"],
  iss: "did:web:example.com:users:5a28a5f8",
  issuer: "did:web:example.com:users:5a28a5f8",
  sub: AGENT,
  validFrom: "2026-07-30T14:29:37.104494Z",
  credentialStatus: {
    type: "BitstringStatusListEntry",
    statusPurpose: "revocation",
    statusListIndex: "100601",
    statusListCredential: "https://example.com/status-list-credential/294bb2be",
  },
  credentialSubject: {
    id: AGENT,
    constraints: { rego: 'count({input.message.body.params.name} & {"search_emails", "read_email"}) > 0' },
    grant: { scopes: [], tools: ["search_emails", "read_email"] },
    scope: [
      {
        protocol: "https://layr8.io/protocols/mcp/1.0",
        messageTypes: ["tools-call"],
        resource: RESOURCE,
      },
    ],
  },
};

const REAL_GRANT_JWT = [
  Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "vc+ld+jwt" })).toString("base64url"),
  Buffer.from(JSON.stringify(REAL_GRANT_CLAIMS)).toString("base64url"),
  "c2lnbmF0dXJl",
].join(".");

/** A node that speaks both halves the client needs, on one port. */
class FakeNode {
  readonly http: Server;
  readonly wss: WebSocketServer;
  readonly frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
  /** Credential reads the client made, with their headers. */
  readonly credentialReads: Array<{ url: string; apiKey?: string }> = [];
  grants: unknown[] = [{ credential_jwt: REAL_GRANT_JWT }];

  constructor() {
    this.http = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/v1/credentials")) {
        this.credentialReads.push({
          url: req.url ?? "",
          apiKey: req.headers["x-api-key"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ credentials: this.grants }));
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws: WS) => {
      ws.on("message", (data: Buffer) => {
        const [ref, , topic, event, payload] = JSON.parse(data.toString()) as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ];
        this.frames.push({ event, payload });

        if (event === "phx_join") {
          ws.send(
            JSON.stringify([
              ref, ref, topic, "phx_reply",
              { status: "ok", response: { did: topic.replace("plugins:", "") } },
            ]),
          );
          return;
        }
        // `null` in the join-ref slot, `ref` in the message-ref slot — the
        // shape a tracked send's reply actually takes. Echoing `ref` into both
        // (as the join reply does) leaves the caller waiting forever.
        if (ref) {
          ws.send(JSON.stringify([null, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        }
      });
    });
  }

  async url(): Promise<string> {
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", () => r()));
    const { port } = this.http.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/plugin_socket/websocket`;
  }

  /** The outbound DIDComm messages, in order. */
  messages(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.event === "message").map((f) => f.payload);
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.wss.close(() => this.http.close(() => r()));
    });
  }
}

let node: FakeNode | null = null;
let client: Layr8Client | null = null;

afterEach(async () => {
  await client?.close();
  await node?.close();
  client = null;
  node = null;
});

/**
 * Fire-and-forget on purpose. `withGrants` runs BEFORE the acknowledgement
 * branch, so this exercises exactly the same path while keeping a Phoenix
 * reply-frame mock — which is not what is under test — out of it.
 */
async function sent(c: Layr8Client, msg: Record<string, unknown>): Promise<void> {
  await c.send(msg as never, { fireAndForget: true });
  await new Promise((r) => setTimeout(r, 20));
}

async function connected(cfg: Record<string, unknown> = {}): Promise<Layr8Client> {
  node = new FakeNode();
  const nodeUrl = await node.url();
  client = new Layr8Client(discard, {
    nodeUrl,
    apiKey: "test-api-key",
    agentDid: AGENT,
    ...cfg,
  });
  await client.connect();
  return client;
}

describe("a grant reaches the wire", () => {
  it("attaches the covering grant to a sent message", async () => {
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "read_email" } },
    });

    const [msg] = node!.messages();
    const attachments = msg.attachments as Array<Record<string, unknown>>;

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      media_type: "application/vc+jwt",
      data: { jws: REAL_GRANT_JWT },
    });
  });

  it("attaches on `request` too — not only on `send`", async () => {
    // The half that gets forgotten. A wallet wired into one outbound path and
    // not the other fails exactly where the caller expects a reply, which is
    // where most grant-needing traffic lives.
    const c = await connected();

    void c.request(
      { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } },
      { timeoutMs: 50 },
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 80));

    const [msg] = node!.messages();
    expect((msg.attachments as unknown[]) ?? []).toHaveLength(1);
  });

  it("asks the node the way the node expects to be asked", async () => {
    // Every one of these is a way this feature silently does nothing: a dropped
    // query string means `holder_did` is missing and the node answers 400; a
    // missing api key means 401; a wrong path means 404. All three surface as
    // "no grant covers this call" — the same denial as having no grant, which is
    // the misreading this whole change exists to end.
    //
    // The route, the parameter and the response shape are the node's
    // (`GET /api/v1/credentials?holder_did=…` under scope `/api/v1`, returning
    // `{credentials: [{credential_jwt, …}]}`), and the MCP broker has been
    // reading them in production this way for months.
    const c = await connected();
    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });

    const [read] = node!.credentialReads;
    expect(read.url).toBe(`/api/v1/credentials?holder_did=${encodeURIComponent(AGENT)}`);
    expect(read.apiKey).toBe("test-api-key");
  });
});

describe("what it must NOT do", () => {
  it("sends nothing extra when no grant covers the message", async () => {
    // Most DIDComm traffic — discovery, trust-ping, problem reports — rides the
    // node's allow rules with no grant. Refusing, or attaching a grant that does
    // not cover, would break more than it protects.
    const c = await connected();

    await sent(c, { to: [RESOURCE], type: "https://didcomm.org/trust-ping/2.0/ping", body: {} });

    const [msg] = node!.messages();
    expect(msg.attachments).toBeUndefined();
  });

  it("does not attach a grant whose tool allowlist excludes this call", async () => {
    // The real credential allows `search_emails` and `read_email`. Its own
    // embedded rego would deny `send_email`, so attaching it is noise that
    // produces a denial naming the grant rather than the missing authority.
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "send_email" } },
    });

    expect(node!.messages()[0].attachments).toBeUndefined();
  });

  it("never displaces attachments the caller supplied", async () => {
    const c = await connected();
    const mine = [{ id: "mine", media_type: "application/json", data: { json: { a: 1 } } }];

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "read_email" } },
      attachments: mine,
    });

    expect(node!.messages()[0].attachments).toMatchObject(mine);
  });

  it("still sends when the credential read fails", async () => {
    // The node decides whether this message needed a grant. A transient read
    // error must not take down calls that never needed us.
    const c = await connected();
    node!.grants = [];
    node!.http.close();

    await expect(
      sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } }),
    ).resolves.toBeUndefined();
  });

  it("does not attach at all when turned off", async () => {
    const c = await connected({ attachGrants: false });

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });

    expect(node!.messages()[0].attachments).toBeUndefined();
    expect(node!.credentialReads).toEqual([]);
  });
});

describe("onGrantMiss", () => {
  it("fires when nothing covered the message — the only party that knows", async () => {
    // The node's denial names the grant it could not find, which sends people to
    // check a grant that is fine. The sender is the only one that knows nothing
    // was attached.
    const misses: Array<{ to: string[]; type: string }> = [];
    const c = await connected({ onGrantMiss: (i: { to: string[]; type: string }) => misses.push(i) });

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "send_email" } } });

    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ to: [RESOURCE], type: MCP_CALL });
  });

  it("does NOT fire when a grant was attached", async () => {
    const misses: unknown[] = [];
    const c = await connected({ onGrantMiss: (i: unknown) => misses.push(i) });

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });

    expect(misses).toEqual([]);
  });
});
