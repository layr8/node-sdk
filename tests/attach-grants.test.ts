// Grants reach the WIRE, not just the wallet.
//
// `wallet.test.ts` proves the selection. This proves the wiring, which is the
// half that has been wrong elsewhere in this system: a fix applied to `send` and
// not to `request`, or an attachment built in the right shape and never put on
// the frame. Asserting the code "looks like" it attaches is not the same claim.
//
// The credential below has the SHAPE of a real grant read from a live node —
// top-level claims with no `vc` wrapper, a `grant.tools` allowlist, an MCP
// `tools-call` scope bound to one resource — so the parser is exercised against
// what the node actually stores rather than something invented to match it.
//
// Every identifier in it is fabricated. This repo is public, and a status-list
// index or credential id copied verbatim from a live node is a pointer into a
// real deployment; the shape carries the whole test value and the values carry
// none of it.
//
// The fake node serves BOTH the WebSocket and the credential REST endpoint on
// one port, because that is the relationship the client assumes: it derives the
// REST base from the socket URL. A test with two ports would pass while the
// derivation was wrong.

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Layr8Client,
  identityAttachment,
  isIdentityAttachment,
  type ErrorHandler,
} from "../src/index.js";
import type { Config, GrantMissInfo } from "../src/config.js";
import { MAX_ATTACHED } from "../src/wallet.js";

const discard: ErrorHandler = () => {};

const AGENT = "did:web:example.com:agents:myclaude";
const RESOURCE = "did:web:example.com:mcp:gmail-stdio:gmail-stdio";
const MCP_CALL = "https://layr8.io/protocols/mcp/1.0/tools-call";

/** A VG in the stored shape. Claims live at the payload's TOP LEVEL, not under `vc`. */
const REAL_GRANT_CLAIMS = {
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://layr8.io/contexts/grant/v1",
  ],
  id: "urn:uuid:vg-mcp-test-0000-0000-000000000001",
  jti: "urn:uuid:vg-mcp-test-0000-0000-000000000001",
  type: ["VerifiableCredential", "VerifiableGrant"],
  iss: "did:web:example.com:users:testowner",
  issuer: "did:web:example.com:users:testowner",
  sub: AGENT,
  validFrom: "2026-07-30T14:29:37.104494Z",
  credentialStatus: {
    type: "BitstringStatusListEntry",
    statusPurpose: "revocation",
    statusListIndex: "1",
    statusListCredential: "https://example.com/status-list-credential/test-status-list",
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

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "vc+ld+jwt" })).toString(
  "base64url",
);

const REAL_GRANT_JWT = [
  JWT_HEADER,
  Buffer.from(JSON.stringify(REAL_GRANT_CLAIMS)).toString("base64url"),
  "c2lnbmF0dXJl",
].join(".");

/**
 * The same grant under a different identity, for testing how a HOLDING behaves.
 * Distinct ids because two attachments sharing one id is a separate defect, and
 * a test that reproduced it would be measuring that instead.
 */
function grantVariant(n: number): string {
  const id = `urn:uuid:vg-mcp-test-0000-0000-${String(n).padStart(12, "0")}`;
  return [
    JWT_HEADER,
    Buffer.from(JSON.stringify({ ...REAL_GRANT_CLAIMS, id, jti: id })).toString("base64url"),
    `c2lnbmF0dXJl${n}`,
  ].join(".");
}

/** A node that speaks both halves the client needs, on one port. */
class FakeNode {
  readonly http: Server;
  readonly wss: WebSocketServer;
  private socket: WS | null = null;
  readonly frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
  /** Credential reads the client made, with their headers. */
  readonly credentialReads: Array<{ url: string; apiKey?: string }> = [];
  grants: unknown[] = [{ credential_jwt: REAL_GRANT_JWT }];
  /** Delay on the credential read, to make the ordering race deterministic. */
  readDelayMs = 0;
  /** Answer credential reads with a 500 — a live node that cannot serve them. */
  failReads = false;
  /**
   * Accept the credential read and NEVER answer it. The worst production
   * failure and the one `http.request` has no default defence against: a
   * blackholing load balancer, a node wedged mid-request. Distinct from
   * `failReads` in the only way that matters here — nothing ever settles.
   */
  hangReads = false;
  /** Responses parked by `hangReads`, so teardown can let the server close. */
  private readonly hung: ServerResponse[] = [];

  constructor() {
    this.http = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/v1/credentials")) {
        this.credentialReads.push({
          url: req.url ?? "",
          apiKey: req.headers["x-api-key"] as string | undefined,
        });
        if (this.hangReads) {
          this.hung.push(res);
          return;
        }
        const answer = () => {
          if (this.failReads) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "nope" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ credentials: this.grants }));
        };
        if (this.readDelayMs) setTimeout(answer, this.readDelayMs);
        else answer();
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws: WS) => {
      this.socket = ws;
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

  /**
   * Push a denial back, in the shape the NODE builds it.
   *
   * `report_problem.ex` sets `pthid` to the denied message's thread — its `thid`
   * or, for a message sent without one, its `id` — and sets NO `thid` at all.
   * So the correlation that runs in production is the `parentThreadId` one, and
   * an earlier version of this fixture set `thid` instead: the exact opposite
   * branch. It was not coverage — deleting `parentThreadId` from the client's
   * lookup left all 184 tests green.
   */
  denyLast(code = "e.m.authz.denied"): void {
    this.deny(this.messages().at(-1), code);
  }

  /** Deny one specific outbound message, whenever it was sent. */
  deny(denied: Record<string, unknown> | undefined, code = "e.m.authz.denied"): void {
    if (!denied) return;
    this.push({
      id: `pr-${denied.id as string}`,
      type: "https://didcomm.org/report-problem/2.0/problem-report",
      from: RESOURCE,
      to: [AGENT],
      pthid: (denied.thid as string) || (denied.id as string),
      body: { code, comment: "Authorization requirements not met" },
    });
  }

  /**
   * Deny using `thid` instead. Not what our node does, but the correlation is a
   * peer's choice and a DIDComm implementation is free to thread it that way.
   */
  denyLastByThread(code = "e.m.authz.denied"): void {
    const last = this.messages().at(-1) as Record<string, unknown> | undefined;
    if (!last) return;
    this.push({
      id: `pr-${last.id as string}`,
      type: "https://didcomm.org/report-problem/2.0/problem-report",
      from: RESOURCE,
      to: [AGENT],
      thid: (last.thid as string) || (last.id as string),
      body: { code, comment: "Authorization requirements not met" },
    });
  }

  /** Push an inbound DIDComm message, in the `{context, plaintext}` frame. */
  push(plaintext: Record<string, unknown>): void {
    this.socket?.send(
      JSON.stringify([
        null, null, `plugins:${AGENT}`, "message",
        { context: { recipient: AGENT, authorized: true }, plaintext },
      ]),
    );
  }

  /** The outbound DIDComm messages, in order. */
  messages(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.event === "message").map((f) => f.payload);
  }

  close(): Promise<void> {
    // A parked response holds its socket open, and `Server.close` waits for
    // every open connection — without this the suite would hang on teardown
    // rather than on the thing under test.
    for (const res of this.hung) res.destroy();
    this.hung.length = 0;
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

/**
 * `Partial<Config>`, not `Record<string, unknown>`.
 *
 * The loose type spread into the constructor below erased every config type
 * check in this file. `Config.onGrantMiss` was declared without `denialCode` —
 * the field this callback exists to deliver, used by the README's own example —
 * and nothing here noticed, because nothing here was checking. `tsc` never saw
 * it either: `tsconfig.json` excluded `tests`, which `tsconfig.tests.json` and
 * `npm run lint` now close.
 */
async function connected(
  cfg: Partial<Config> = {},
  /** Runs before `connect()` — handlers may only be registered there. */
  prepare?: (c: Layr8Client) => void,
): Promise<Layr8Client> {
  node = new FakeNode();
  const nodeUrl = await node.url();
  client = new Layr8Client(discard, {
    nodeUrl,
    apiKey: "test-api-key",
    agentDid: AGENT,
    ...cfg,
  });
  prepare?.(client);
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

    // `signal`, not a `timeoutMs` that `RequestOptions` has never had — the
    // stray option compiled only because this file was outside the typecheck,
    // and the request it was meant to bound simply never ended.
    void c.request(
      { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } },
      { signal: AbortSignal.timeout(50) },
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

  it("DOES attach a grant whose allowlist does not name this call", async () => {
    // The real credential allows `search_emails` and `read_email`, not
    // `send_email` — and it is attached anyway. The node's policy allows on the first
    // passing grant and ignores the rest, so over-attaching is free; withholding
    // is what costs a working call, invisibly. The tool allowlist is not a
    // policy input at all: the node evaluates `constraints.rego` by grant id.
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "send_email" } },
    });

    expect((node!.messages()[0].attachments as unknown[]) ?? []).toHaveLength(1);
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

describe("onGrantMiss fires on the DENIAL, not on every send", () => {
  // Announcing at send time fired on every message that legitimately needs no
  // grant — discovery, trust-ping, problem reports. Measured: five plain pings
  // from a client holding zero credentials produced five callbacks. For the
  // majority of agents, which hold no grants at all, that is one line per
  // outbound message, and a diagnostic that fires constantly is one nobody reads
  // when it matters.
  //
  // The signal wanted is "the node denied, and we had attached nothing" — which
  // needs the denial, and the denial arrives later.

  it("says nothing when a message that needs no grant goes out", async () => {
    const misses: unknown[] = [];
    const c = await connected({ onGrantMiss: (i: unknown) => misses.push(i) });

    for (let n = 0; n < 3; n++) {
      await sent(c, { to: [RESOURCE], type: "https://didcomm.org/trust-ping/2.0/ping", body: {} });
    }

    expect(misses).toEqual([]);
  });

  it("fires when a denial comes back for a message we sent unattached", async () => {
    const misses: Array<{ to: string[]; denialCode?: string }> = [];
    const c = await connected({
      onGrantMiss: (i: { to: string[]; denialCode?: string }) => misses.push(i),
    });

    await sent(c, { to: [RESOURCE], type: "https://layr8.io/protocols/other/1.0/x", body: {} });
    node!.denyLast();
    await new Promise((r) => setTimeout(r, 60));

    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ to: [RESOURCE], denialCode: "e.m.authz.denied" });
  });

  it("does NOT fire when the denial was for a message we DID attach to", async () => {
    // A denial with a grant on the wire is a policy answer, not an omission —
    // and pointing the caller at "you attached nothing" would be false.
    const misses: unknown[] = [];
    const c = await connected({ onGrantMiss: (i: unknown) => misses.push(i) });

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });
    expect((node!.messages()[0].attachments as unknown[]) ?? []).toHaveLength(1);

    node!.denyLast();
    await new Promise((r) => setTimeout(r, 60));

    expect(misses).toEqual([]);
  });

  it("ignores a problem report that is not an authorization denial", async () => {
    const misses: unknown[] = [];
    const c = await connected({ onGrantMiss: (i: unknown) => misses.push(i) });

    await sent(c, { to: [RESOURCE], type: "https://layr8.io/protocols/other/1.0/x", body: {} });
    node!.denyLast("e.p.msg.unsupported");
    await new Promise((r) => setTimeout(r, 60));

    expect(misses).toEqual([]);
  });

  it("correlates a denial that threads with `thid` instead of `pthid`", async () => {
    // Our node uses `pthid` and only `pthid`. The correlation is the peer's
    // choice though, so both keys are looked up — and this is the case the old
    // fixture was accidentally the ONLY cover for.
    const misses: GrantMissInfo[] = [];
    const c = await connected({ onGrantMiss: (i) => misses.push(i) });

    await sent(c, { to: [RESOURCE], type: "https://layr8.io/protocols/other/1.0/x", body: {} });
    node!.denyLastByThread();
    await new Promise((r) => setTimeout(r, 60));

    expect(misses).toHaveLength(1);
  });

  it("still reports the denial after a burst of messages that needed no grant", async () => {
    // The bounded map used to evict by COUNT, and `withGrants` records every
    // message it attaches nothing to — which for an agent holding no grants is
    // every trust-ping and discovery message it sends. Sixty-four of those
    // between a message and its denial and the one callback that mattered never
    // fired, silently, which is the failure this whole feature exists to end.
    const misses: GrantMissInfo[] = [];
    const c = await connected({ onGrantMiss: (i) => misses.push(i) });
    node!.grants = [];

    await sent(c, { to: [RESOURCE], type: "https://layr8.io/protocols/other/1.0/x", body: {} });
    const denied = node!.messages()[0];

    for (let n = 0; n < 70; n++) {
      await c.send(
        { to: [RESOURCE], type: "https://didcomm.org/trust-ping/2.0/ping", body: {} } as never,
        { fireAndForget: true },
      );
    }

    node!.deny(denied);
    await new Promise((r) => setTimeout(r, 60));

    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ denialCode: "e.m.authz.denied" });
  });

  it("says so when the cap leaves covering credentials off the message", async () => {
    // A dropped credential and a credential never held produce the SAME denial.
    // The holder is the only party that can tell them apart, so silence here is
    // the same defect in a new place.
    const held = MAX_ATTACHED + 4;
    const misses: GrantMissInfo[] = [];
    const c = await connected({ onGrantMiss: (i) => misses.push(i) });
    node!.grants = Array.from({ length: held }, (_, i) => ({ credential_jwt: grantVariant(i) }));

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });

    expect((node!.messages()[0].attachments as unknown[]).length).toBe(MAX_ATTACHED);
    expect(misses).toHaveLength(1);
    expect(misses[0].capped).toEqual({ covering: held, attached: MAX_ATTACHED });
  });

  it("still announces a credential READ failure at once", async () => {
    // Unlike "nothing covered it", this is never normal — every subsequent send
    // is flying blind, and waiting for a denial would bury it.
    const misses: Array<{ error?: unknown }> = [];
    const c = await connected({ onGrantMiss: (i: { error?: unknown }) => misses.push(i) });
    node!.http.close();

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } });

    expect(misses).toHaveLength(1);
    expect(misses[0].error).toBeDefined();
  });
});

describe("every outbound path, not just `send`", () => {
  // A fix applied to one send path and not another is this system's most
  // repeated defect: `request` and `send` diverged before, and the handler's
  // REPLY is a third path with no caller to notice it. A reply that carries no
  // grant is denied exactly like the original call, except the agent that wrote
  // the handler never made a call at all and has nothing to look at.

  it("attaches to a handler's REPLY", async () => {
    await connected({}, (c) =>
      c.handle("https://layr8.io/protocols/mcp/1.0/tools-list", async () => ({
        type: MCP_CALL,
        body: { params: { name: "read_email" } },
      })),
    );

    node!.push({
      id: "inbound-1",
      type: "https://layr8.io/protocols/mcp/1.0/tools-list",
      from: RESOURCE,
      to: [AGENT],
      thid: "thread-1",
      body: {},
    });
    await new Promise((r) => setTimeout(r, 80));

    const reply = node!.messages().find((m) => m.type === MCP_CALL);
    expect(reply, "the handler's reply never reached the wire").toBeDefined();
    expect((reply!.attachments as unknown[]) ?? []).toHaveLength(1);
  });
});

describe("call order survives the grant read", () => {
  // Attaching put an `await` in front of every write, including the
  // fire-and-forget branch that previously had none. Measured before the fix:
  // `send(A)` then `send(B)`, with A's credential read the slower, arrived as
  // [B, A]. An agent that emits a sequence without awaiting each call is
  // entitled to its order, and a public SDK does not get to change that quietly.
  it("writes A before B even when only A waits on the wallet", async () => {
    const c = await connected();
    node!.readDelayMs = 60;

    // A must consult the wallet; B carries its own attachment, so `withGrants`
    // returns at once and would overtake A without the write chain.
    const a = c.send(
      { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } } as never,
      { fireAndForget: true },
    );
    const b = c.send(
      {
        to: [RESOURCE],
        type: MCP_CALL,
        body: {},
        attachments: [{ id: "caller", media_type: "application/json", data: { json: {} } }],
      } as never,
      { fireAndForget: true },
    );
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 120));

    const ids = node!.messages().map((m) => (m.attachments as Array<{ id: string }>)[0]?.id);
    expect(ids).toEqual(["urn:uuid:vg-mcp-test-0000-0000-000000000001", "caller"]);
  });
});

describe("a credential read that never answers", () => {
  // The read runs INSIDE the per-channel write chain, because the write order
  // has to be the call order. That makes an unbounded read a channel-wide
  // deadlock, and `http.request` has no default timeout to end it: measured
  // before the deadline, a node that accepted the TCP connection and never
  // answered left `send()` neither resolved nor rejected, forever — and took
  // every later send on that channel with it, including ones carrying their own
  // attachments that never touch the wallet.
  //
  // "The wallet must not block the send" was already the rule. It held for a
  // read that FAILS. A read that HANGS is the commoner production failure — a
  // blackholing load balancer, a wedged node — and it did not hold at all.

  it("gives up, sends anyway, and lets the next message through", async () => {
    const misses: GrantMissInfo[] = [];
    const c = await connected({ grantReadTimeoutMs: 80, onGrantMiss: (i) => misses.push(i) });
    node!.hangReads = true;

    const started = Date.now();
    // A consults the wallet. B carries its own attachment, so `withGrants`
    // returns on its first line and B never reads anything — it is here to
    // prove the HEAD-OF-LINE half: before the deadline, B hung on A.
    const a = c.send(
      { to: [RESOURCE], type: MCP_CALL, body: { params: { name: "read_email" } } } as never,
      { fireAndForget: true },
    );
    const b = c.send(
      {
        to: [RESOURCE],
        type: MCP_CALL,
        body: {},
        attachments: [{ id: "caller", media_type: "application/json", data: { json: {} } }],
      } as never,
      { fireAndForget: true },
    );

    // Neither of these settles at all without the deadline; the assertion below
    // is the bound, and the suite timeout is the backstop.
    await Promise.all([a, b]);
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, 20));

    expect(elapsed).toBeLessThan(2_000);
    // A goes out unattached rather than not at all: the node is the authority
    // on whether it needed a grant.
    const ids = node!.messages().map((m) => (m.attachments as Array<{ id: string }> | undefined));
    expect(ids[0]).toBeUndefined();
    expect(ids[1]?.[0]?.id).toBe("caller");

    // A timeout is a read failure, and a read failure is announced at once.
    expect(misses).toHaveLength(1);
    expect(String((misses[0].error as Error).message)).toContain("timed out");
  });
});

describe("a cold start does not stampede the node", () => {
  it("reads the holder's grants ONCE for a burst of sends", async () => {
    // Two mechanisms hold this up and only one is visible here: the write chain
    // serializes same-channel sends, so the second already finds a warm cache.
    // The promise cache is what covers callers the chain does NOT serialize, and
    // that claim is pinned in `wallet.test.ts` where it is actually made — a
    // test that passes for the wrong reason is not coverage.
    const c = await connected();
    node!.readDelayMs = 40;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        c.send({ to: [RESOURCE], type: MCP_CALL, body: {} } as never, { fireAndForget: true }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));

    expect(node!.credentialReads).toHaveLength(1);
  });

  it("does not pay a full failing round trip on EVERY send", async () => {
    // The mirror image: only caching successes turns a config mistake — an API
    // key that cannot read credentials — into a permanent per-message latency
    // tax, forever, on an agent that is otherwise working.
    //
    // The node stays UP and answers 500. An earlier version of this test closed
    // the server instead, so the request never reached `credentialReads` and the
    // assertion held no matter what the cache did.
    const c = await connected();
    node!.failReads = true;

    for (let n = 0; n < 4; n++) {
      await sent(c, { to: [RESOURCE], type: MCP_CALL, body: {} });
    }

    expect(node!.credentialReads).toHaveLength(1);
  });

  it("but lets a failure LAPSE, so a fixed key works without a restart", async () => {
    const c = await connected({ grantCacheMs: 120 });
    node!.failReads = true;
    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: {} });

    node!.failReads = false;
    await new Promise((r) => setTimeout(r, 120));
    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: {} });

    expect((node!.messages().at(-1)!.attachments as unknown[]) ?? []).toHaveLength(1);
  });
});

describe("a freshly issued grant, without waiting out the cache", () => {
  it("refreshGrants() makes the next send see it", async () => {
    // An agent that has just been told it was granted something should not have
    // to wait out a timer it cannot see. Before this the wallet's `refresh` was
    // unreachable — private field, unexported class — so the cure was a restart.
    const c = await connected();
    node!.grants = [];
    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: {} });
    expect((node!.messages().at(-1)!.attachments as unknown[]) ?? []).toHaveLength(0);

    node!.grants = [{ credential_jwt: REAL_GRANT_JWT }];
    c.refreshGrants();
    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: {} });

    expect((node!.messages().at(-1)!.attachments as unknown[]) ?? []).toHaveLength(1);
  });
});

describe("a failed write is still a failed write", () => {
  // The write chain must not become a place errors go to die: `send()` that
  // resolves on a dropped connection is the same silence this change is about.
  it("rejects the caller when the message cannot go out", async () => {
    const c = await connected();
    await c.close();

    await expect(
      c.send({ to: [RESOURCE], type: MCP_CALL, body: {} } as never, { fireAndForget: true }),
    ).rejects.toThrow();
  });

  it("but one failed write does not sink the next one on that channel", async () => {
    const c = await connected();

    // A message that cannot be marshalled: the chain must recover, not stall.
    await expect(
      c.send({ to: [RESOURCE], type: MCP_CALL, body: cyclic() } as never, {
        fireAndForget: true,
      }),
    ).rejects.toThrow();

    await sent(c, { to: [RESOURCE], type: MCP_CALL, body: { ok: true } });
    expect(node!.messages().at(-1)!.type).toBe(MCP_CALL);
  });
});


// ---------------------------------------------------------------------------
// Identity credentials — "who the sender is", beside the grants that say what
// it may do. Boundary test for the sender -> cloud-node identity-credential
// contract: the node routes an attachment on `credentialSubject.scope` alone,
// so the two claims the SDK must keep straight are "no scope, so identity" and
// "has a scope, so grant".
// ---------------------------------------------------------------------------

/**
 * An identity credential in the stored shape: same top-level claims, same
 * media type as a grant — and NO `credentialSubject.scope`. That absence is the
 * entire discriminator, on this side and on the node's.
 *
 * Every identifier is fabricated, for the reason given at the top of this file.
 */
const IDENTITY_CLAIMS = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: "urn:uuid:idc-test-0000-0000-000000000042",
  jti: "urn:uuid:idc-test-0000-0000-000000000042",
  type: ["VerifiableCredential", "EmploymentCredential"],
  iss: "did:web:example.com:users:testissuer",
  issuer: "did:web:example.com:users:testissuer",
  sub: AGENT,
  validFrom: "2026-07-30T14:29:37.104494Z",
  credentialSubject: {
    id: AGENT,
    employer: "Example Incorporated",
    role: "buyer",
  },
};

const IDENTITY_JWT = [
  JWT_HEADER,
  Buffer.from(JSON.stringify(IDENTITY_CLAIMS)).toString("base64url"),
  "aWRlbnRpdHktc2ln",
].join(".");

describe("an identity credential reaches the wire", () => {
  it("goes out exactly as the caller built it", async () => {
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "read_email" } },
      attachments: [identityAttachment(IDENTITY_JWT)],
    });

    const attachments = node!.messages()[0].attachments as Array<Record<string, unknown>>;
    expect(attachments[0]).toEqual({
      id: IDENTITY_CLAIMS.id,
      media_type: "application/vc+jwt",
      data: { jws: IDENTITY_JWT },
    });
  });

  it("does not cost the message its grant", async () => {
    // The half that would be silently wrong. Under the old rule ANY
    // caller-supplied attachment made the wallet stand aside, so saying who you
    // are meant sending nothing that says what you may do — and the node's
    // denial then read "no grant covers this call", which is precisely the
    // message that sends people looking at their grant configuration.
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "read_email" } },
      attachments: [identityAttachment(IDENTITY_JWT)],
    });

    const attachments = node!.messages()[0].attachments as Array<Record<string, unknown>>;
    // The caller's stays FIRST and unmodified; the wallet's selection follows.
    expect(attachments.map((a) => a.id)).toEqual([
      IDENTITY_CLAIMS.id,
      "urn:uuid:vg-mcp-test-0000-0000-000000000001",
    ]);
    expect(attachments[1]).toMatchObject({
      media_type: "application/vc+jwt",
      data: { jws: REAL_GRANT_JWT },
    });
  });

  it("refuses a credential that has a scope — that is a grant", () => {
    // Not a taste call. cloud-node would route it as a grant, where
    // it can never satisfy a `senderCredentials` requirement, and the denial
    // that follows is byte-for-byte the one for attaching nothing at all. The
    // check is local and exact, so the choice is between throwing at the call
    // site and a misroute diagnosed at the far end.
    expect(() => identityAttachment(REAL_GRANT_JWT)).toThrow(/Verifiable Grant/);
    expect(isIdentityAttachment({ media_type: "application/vc+jwt", data: { jws: REAL_GRANT_JWT } }))
      .toBe(false);
    expect(isIdentityAttachment({ media_type: "application/vc+jwt", data: { jws: IDENTITY_JWT } }))
      .toBe(true);
  });

  it("leaves a caller-attached GRANT displacing the wallet, as before", async () => {
    // The other side of the narrowing: only identity credentials keep the
    // wallet running. A caller attaching a grant is still saying "use mine".
    const c = await connected();

    await sent(c, {
      to: [RESOURCE],
      type: MCP_CALL,
      body: { params: { name: "read_email" } },
      attachments: [{ id: "mine", media_type: "application/vc+jwt", data: { jws: grantVariant(9) } }],
    });

    const attachments = node!.messages()[0].attachments as Array<Record<string, unknown>>;
    expect(attachments.map((a) => a.id)).toEqual(["mine"]);
  });

  it("refuses anything that is not a compact JWS", () => {
    // The node can verify nothing else, so attaching it only buys a denial that
    // names the wrong problem.
    expect(() => identityAttachment("not-a-jws")).toThrow(/compact JWS/);
    expect(() => identityAttachment("a.b.")).toThrow(/compact JWS/);
  });
});

function cyclic(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  o.self = o;
  return o;
}
