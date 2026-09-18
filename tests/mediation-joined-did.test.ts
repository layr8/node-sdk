// Mediation on a DID joined with `joinDid`, not only on the client's primary.
//
// hygiene-ok: "mediator" is the domain word this module is about and is
// already used throughout src/mediation.ts; it is not a system reference here.
//
// A client can hold one DID as its primary and join others beside it. When the
// mediation row belongs to a joined DID, three separate things have to name
// that DID, and each of them fails in the direction that reads as healthy:
//
//   1. the outbound steps — `enroll`'s recipient-update and the shared request
//      helper's `from`, and `declare`'s REST path. Sent as the primary, the
//      mediator still answers `mediate-grant` and the node still records a
//      declaration; both are for the wrong DID.
//   2. the acknowledgement — `collect`'s `messages-received`. Sent as the
//      primary, the mediator holds no mediation row for it, so the drain
//      reports what it collected and the mailbox never empties.
//   3. the live `delivery` push — the handler was registered client-globally
//      and acknowledged as the primary, and the two mediation protocols were
//      bound only on the primary's join. The node routes to a channel only the
//      protocols that channel bound, so without them the enrolment succeeds,
//      the drain succeeds, `status` reports `live_delivery: true` and no push
//      is ever delivered.
//
// The mediator here is a fake: one HTTP server that serves both the Phoenix
// socket (answering coordinate-mediation/3.0 and messagepickup/3.0 on
// whichever topic — i.e. DID — the request arrived on) and the node's REST
// surface, including `/didcomm` re-injection. Every assertion is about the DID
// a frame went out as, which is what a real mediator keys its rows on.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { WebSocketServer, WebSocket as WS } from "ws";
import {
  Layr8Client,
  mediation,
  MEDIATION_DELIVERY_TYPE,
  MEDIATION_PROTOCOLS,
  type Attachment,
  type ErrorHandler,
} from "../src/index.js";

const discard: ErrorHandler = () => {};

const CM = "https://didcomm.org/coordinate-mediation/3.0/";
const PICKUP = "https://didcomm.org/messagepickup/3.0/";

/** The client's primary DID — the one `connect()` binds. */
const PRIMARY = "did:web:n:agents:host";
/** The DID joined beside it, whose mediation row this is. */
const JOINED = "did:web:n:agents:acme";
const MEDIATOR_DID = "did:web:n:agents:store-and-forward";
/** A DID this client neither holds as its primary nor has joined. */
const STRANGER = "did:web:n:agents:stranger";

/** A DIDComm frame the fake node received, with the DID it went out as. */
interface Outbound {
  /** The envelope's `from` — the DID the far end keys its row on. */
  did: string;
  /** The channel topic it was written to, which must agree with `from`. */
  channel: string;
  type: string;
  body: Record<string, unknown>;
}

const jwe = (tag: string) => `{"protected":"p","ciphertext":"${tag}"}`;
const att = (id: string, text: string): Attachment => ({
  id,
  data: { base64: Buffer.from(text).toString("base64url") },
});

/**
 * One server for both surfaces the SDK talks to, because the SDK derives its
 * REST base from the WebSocket URL and so both must be the same origin.
 *
 * Replies are pushed back on the SAME topic the request arrived on, which is
 * what makes these tests discriminating: a step taken as the primary arrives
 * on the primary's topic and is recorded under that DID.
 */
class FakeNode {
  private http: http.Server;
  private wss: WebSocketServer;
  private socket: WS | null = null;
  /** `payload_types` per joined DID. */
  readonly joined = new Map<string, string[]>();
  /** Every outbound DIDComm message, in order, with the DID it went out as. */
  readonly out: Outbound[] = [];
  /** REST requests, in order. */
  readonly rest: Array<{ method: string; url: string; body: string }> = [];
  /** `delivery-request` replies to serve, in order. Exhausted ⇒ `status`. */
  readonly deliveries: Attachment[][] = [];
  private port = 0;

  constructor() {
    this.http = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.rest.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(req.url === "/didcomm" ? 202 : 200, {
          "content-type": "application/json",
        });
        res.end("{}");
      });
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws: WS) => {
      this.socket = ws;
      ws.on("message", (data: Buffer) => {
        const [joinRef, ref, topic, event, payload] = JSON.parse(data.toString()) as [
          string | null,
          string | null,
          string,
          string,
          Record<string, unknown>,
        ];
        const did = topic.replace("plugins:", "");

        if (event === "phx_join") {
          this.joined.set(did, (payload.payload_types as string[]) ?? []);
          ws.send(
            JSON.stringify([ref, ref, topic, "phx_reply", { status: "ok", response: { did } }]),
          );
          return;
        }
        if (event === "phx_leave") {
          ws.send(
            JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]),
          );
          return;
        }
        if (event === "message") {
          const msg = payload as unknown as Record<string, unknown>;
          const type = String(msg.type ?? "");
          this.out.push({
            did: String(msg.from ?? ""),
            channel: did,
            type,
            body: (msg.body ?? {}) as Record<string, unknown>,
          });
          if (ref) {
            ws.send(
              JSON.stringify([null, ref, topic, "phx_reply", { status: "ok", response: {} }]),
            );
          }
          this.answer(topic, String(msg.id ?? ""), String(msg.thid ?? msg.id ?? ""), type);
          return;
        }
        if (ref) {
          ws.send(JSON.stringify([null, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        }
      });
    });
  }

  /** The mediator's reply, pushed on the topic the request came in on. */
  private answer(topic: string, id: string, thid: string, type: string): void {
    const on = topic.replace("plugins:", "");
    const reply = (replyType: string, body: unknown, attachments?: Attachment[]) =>
      this.pushOnTopic(topic, {
        id: `r-${id}`,
        type: replyType,
        from: MEDIATOR_DID,
        thid,
        body,
        attachments,
      });

    switch (type) {
      case `${CM}mediate-request`:
        reply(`${CM}mediate-grant`, { routing_did: [MEDIATOR_DID] });
        return;
      case `${CM}recipient-update`:
        // A real mediator echoes the DID it registered. The fake registers
        // whatever asked, so the assertion is on the DID that asked.
        reply(`${CM}recipient-update-response`, {
          updated: [{ recipient_did: on, result: "success" }],
        });
        return;
      case `${PICKUP}delivery-request`: {
        const next = this.deliveries.shift();
        if (!next || next.length === 0) {
          reply(`${PICKUP}status`, { message_count: 0 });
          return;
        }
        reply(`${PICKUP}delivery`, { recipient_did: on }, next);
        return;
      }
      case `${PICKUP}messages-received`:
      case `${PICKUP}status-request`:
        reply(`${PICKUP}status`, { message_count: 0 });
        return;
      case `${PICKUP}live-delivery-change`:
        reply(`${PICKUP}status`, { live_delivery: true, message_count: 0 });
        return;
      default:
        return;
    }
  }

  /** Push an inbound DIDComm message on a DID's channel. */
  pushOnDid(did: string, msg: Record<string, unknown>): void {
    this.pushOnTopic(`plugins:${did}`, msg);
  }

  /** The node wraps every inbound plaintext in an envelope. */
  private pushOnTopic(topic: string, msg: unknown): void {
    if (this.socket && this.socket.readyState === WS.OPEN) {
      this.socket.send(
        JSON.stringify([null, null, topic, "message", { plaintext: msg }]),
      );
    }
  }

  /** The DIDs that frames of this type went out as, in order. */
  sentAs(type: string): string[] {
    return this.out.filter((o) => o.type === type).map((o) => o.did);
  }

  bodyOf(type: string): Record<string, unknown> | undefined {
    return this.out.find((o) => o.type === type)?.body;
  }

  restCalls(method: string): Array<{ method: string; url: string; body: string }> {
    return this.rest.filter((r) => r.method === method);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(0, "127.0.0.1", () => {
        this.port = (this.http.address() as { port: number }).port;
        resolve();
      });
    });
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}/plugin_socket/websocket`;
  }

  async close(): Promise<void> {
    // Drop the socket first: a failed assertion skips the client's own
    // close(), and an open socket holds both servers open until they time out.
    this.socket?.terminate();
    this.socket = null;
    await new Promise<void>((r) => this.wss.close(() => r()));
    // Release the port promptly: a keep-alive connection would hold it open
    // and the file's servers are created once per test.
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}

let node: FakeNode;

beforeEach(async () => {
  node = new FakeNode();
  await node.listen();
});

afterEach(async () => {
  await node.close();
});

/**
 * A client whose primary is one DID, with a second DID joined beside it. The
 * primary has NO mediator configured: the mediation row belongs to the joined
 * DID, which is the case the old code could not express.
 */
async function connected(joinOpts?: { mediated?: boolean }) {
  const client = new Layr8Client(discard, {
    nodeUrl: node.url(),
    apiKey: "k",
    agentDid: PRIMARY,
  });
  client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
  await client.connect();
  const handle = await client.joinDid(JOINED, {
    protocols: ["https://didcomm.org/basicmessage/2.0"],
    mediated: joinOpts?.mediated,
  });
  return { client, handle };
}

describe("the outbound steps act as the given DID", () => {
  it("enroll registers the joined DID, not the primary", async () => {
    const { client } = await connected();

    const r = await mediation.enroll(client, MEDIATOR_DID, { did: JOINED });

    expect(r.ok).toBe(true);
    expect(node.sentAs(`${CM}mediate-request`)).toEqual([JOINED]);
    expect(node.sentAs(`${CM}recipient-update`)).toEqual([JOINED]);
    expect(node.bodyOf(`${CM}recipient-update`)?.updates).toEqual([
      { recipient_did: JOINED, action: "add" },
    ]);
    // The envelope's sender and the channel it was written to are the same
    // DID, so neither reading can be right by accident.
    expect(node.out.every((o) => o.did === o.channel)).toBe(true);

    await client.close();
  });

  it("declare and undeclare use the joined DID's mediator path", async () => {
    const { client } = await connected();

    expect(await mediation.declare(client, MEDIATOR_DID, { did: JOINED })).toEqual({ ok: true });
    expect(node.restCalls("PUT")[0]?.url).toBe(`/api/v1/dids/${JOINED}/mediator`);

    expect(await mediation.undeclare(client, { did: JOINED })).toEqual({ ok: true });
    expect(node.restCalls("DELETE")[0]?.url).toBe(`/api/v1/dids/${JOINED}/mediator`);

    await client.close();
  });

  it("defaults to the primary DID when no DID is given", async () => {
    const { client } = await connected();

    expect(await mediation.status(client, MEDIATOR_DID)).toMatchObject({ ok: true });
    expect(node.sentAs(`${PICKUP}status-request`)).toEqual([PRIMARY]);
    expect(await mediation.declare(client, MEDIATOR_DID)).toEqual({ ok: true });
    expect(node.restCalls("PUT")[0]?.url).toBe(`/api/v1/dids/${PRIMARY}/mediator`);

    await client.close();
  });

  it("declare and undeclare refuse an unhosted DID before writing anything", async () => {
    const { client } = await connected();

    const put = await mediation.declare(client, MEDIATOR_DID, { did: STRANGER });
    const del = await mediation.undeclare(client, { did: STRANGER });

    expect(put.ok).toBe(false);
    expect(del.ok).toBe(false);
    expect(String((put as { error: unknown }).error)).toContain(STRANGER);
    // The declaration is a REST write against the node. Sent for a DID this
    // client does not hold, it succeeds and points that DID's routing
    // somewhere nobody is listening.
    expect(node.restCalls("PUT")).toEqual([]);
    expect(node.restCalls("DELETE")).toEqual([]);

    await client.close();
  });

  it("refuses a DID that is neither the primary nor joined instead of falling back", async () => {
    const { client } = await connected();

    const r = await mediation.status(client, MEDIATOR_DID, { did: STRANGER });

    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toContain(STRANGER);
    // Nothing went out as the primary in its place.
    expect(node.sentAs(`${PICKUP}status-request`)).toEqual([]);

    await client.close();
  });
});

describe("the acknowledgement goes out as the same DID", () => {
  it("collect acknowledges as the joined DID", async () => {
    const { client } = await connected();

    const r = await mediation.collect(client, MEDIATOR_DID, [att("m1", jwe("one"))], {
      did: JOINED,
    });

    expect(r).toEqual({ collected: 1, complete: true });
    expect(node.sentAs(`${PICKUP}messages-received`)).toEqual([JOINED]);
    expect(node.bodyOf(`${PICKUP}messages-received`)?.message_id_list).toEqual(["m1"]);

    await client.close();
  });

  it("collect refuses an unhosted DID instead of reporting what it could not acknowledge", async () => {
    const { client } = await connected();

    // The ack for an unhosted DID cannot be sent at all. Answering `collected`
    // would put the ciphertext into the node while nothing clears the queue,
    // so the same message is delivered again on the next drain — and the
    // caller was told it was collected.
    await expect(
      mediation.collect(client, MEDIATOR_DID, [att("m1", jwe("one"))], { did: STRANGER }),
    ).rejects.toThrow(STRANGER);

    expect(node.sentAs(`${PICKUP}messages-received`)).toEqual([]);
    // The refusal comes before the re-injection, so nothing was delivered
    // twice: the queue still holds the message and will offer it again.
    expect(node.rest.filter((r) => r.url === "/didcomm")).toEqual([]);

    await client.close();
  });

  it("pickup reports the refusal rather than a collected count", async () => {
    const { client } = await connected();
    node.deliveries.push([att("m1", jwe("one"))]);

    const r = await mediation.pickup(client, MEDIATOR_DID, { did: STRANGER });

    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toContain(STRANGER);

    await client.close();
  });

  it("pickup drains and acknowledges every round as the joined DID", async () => {
    const { client } = await connected();
    node.deliveries.push(
      [att("m1", jwe("one")), att("m2", jwe("two"))],
      [att("m3", jwe("three"))],
    );

    const r = await mediation.pickup(client, MEDIATOR_DID, { did: JOINED });

    expect(r).toEqual({ ok: true, collected: 3 });
    expect(node.sentAs(`${PICKUP}delivery-request`)).toEqual([JOINED, JOINED, JOINED]);
    expect(node.sentAs(`${PICKUP}messages-received`)).toEqual([JOINED, JOINED]);
    expect(node.rest.filter((r) => r.url === "/didcomm").length).toBe(3);

    await client.close();
  });

  it("bootstrap runs every step as the joined DID", async () => {
    const { client } = await connected();
    node.deliveries.push([att("m1", jwe("one"))]);

    const r = await mediation.bootstrap(client, MEDIATOR_DID, { did: JOINED });

    expect(r).toEqual({ ok: true, collected: 1 });
    for (const t of [
      `${CM}mediate-request`,
      `${CM}recipient-update`,
      `${PICKUP}delivery-request`,
      `${PICKUP}messages-received`,
      `${PICKUP}live-delivery-change`,
    ]) {
      expect(node.sentAs(t), t).not.toContain(PRIMARY);
      expect(node.sentAs(t), t).toContain(JOINED);
    }
    expect(node.restCalls("PUT")[0]?.url).toBe(`/api/v1/dids/${JOINED}/mediator`);

    await client.close();
  });
});

describe("the live delivery handler is per DID", () => {
  it("a mediated join binds both mediation protocols", async () => {
    const { client } = await connected({ mediated: true });

    const bound = node.joined.get(JOINED) ?? [];
    expect(bound).toContain("https://didcomm.org/coordinate-mediation/3.0");
    expect(bound).toContain("https://didcomm.org/messagepickup/3.0");
    // The caller's own protocol and the auto-added problem report stay.
    expect(bound).toContain("https://didcomm.org/basicmessage/2.0");
    expect(bound).toContain("https://didcomm.org/report-problem/2.0");
    // The primary is not mediated, so nothing was added to its join.
    expect(node.joined.get(PRIMARY) ?? []).not.toContain(
      "https://didcomm.org/messagepickup/3.0",
    );

    await client.close();
  });

  it("a live push on the joined DID is re-injected and acknowledged as that DID", async () => {
    const { client } = await connected({ mediated: true });

    node.pushOnDid(JOINED, {
      id: "push-1",
      type: MEDIATION_DELIVERY_TYPE,
      from: MEDIATOR_DID,
      body: { recipient_did: JOINED },
      attachments: [att("live-1", jwe("live"))],
    });

    await expect
      .poll(() => node.sentAs(`${PICKUP}messages-received`), { timeout: 3000 })
      .toEqual([JOINED]);
    expect(node.bodyOf(`${PICKUP}messages-received`)?.message_id_list).toEqual(["live-1"]);
    expect(node.rest.filter((r) => r.url === "/didcomm").length).toBe(1);

    await client.close();
  });

  it("a caller that passes the mediation protocols itself gets them once", async () => {
    const client = new Layr8Client(discard, {
      nodeUrl: node.url(),
      apiKey: "k",
      agentDid: PRIMARY,
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();
    await client.joinDid(JOINED, {
      protocols: [...MEDIATION_PROTOCOLS, "https://didcomm.org/basicmessage/2.0"],
      mediated: true,
    });

    const bound = node.joined.get(JOINED) ?? [];
    for (const p of MEDIATION_PROTOCOLS) {
      expect(bound.filter((b) => b === p).length, p).toBe(1);
    }

    await client.close();
  });

  it("an unmediated join binds no mediation protocol and handles no delivery", async () => {
    const { client } = await connected();

    expect(node.joined.get(JOINED) ?? []).not.toContain(
      "https://didcomm.org/messagepickup/3.0",
    );

    node.pushOnDid(JOINED, {
      id: "push-2",
      type: MEDIATION_DELIVERY_TYPE,
      from: MEDIATOR_DID,
      body: {},
      attachments: [att("live-2", jwe("live"))],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(node.sentAs(`${PICKUP}messages-received`)).toEqual([]);

    await client.close();
  });

  it("a caller's own delivery handler wins over the mediated default", async () => {
    const client = new Layr8Client(discard, {
      nodeUrl: node.url(),
      apiKey: "k",
      agentDid: PRIMARY,
    });
    client.handle("https://layr8.io/protocols/echo/1.0/request", async () => null);
    await client.connect();
    const seen: string[] = [];
    await client.joinDid(JOINED, {
      protocols: ["https://didcomm.org/basicmessage/2.0"],
      mediated: true,
      handlers: {
        [MEDIATION_DELIVERY_TYPE]: async (msg) => {
          seen.push(msg.id);
          return null;
        },
      },
    });

    node.pushOnDid(JOINED, {
      id: "push-3",
      type: MEDIATION_DELIVERY_TYPE,
      from: MEDIATOR_DID,
      body: {},
      attachments: [att("live-3", jwe("live"))],
    });

    await expect.poll(() => seen, { timeout: 3000 }).toEqual(["push-3"]);
    expect(node.sentAs(`${PICKUP}messages-received`)).toEqual([]);

    await client.close();
  });
});
