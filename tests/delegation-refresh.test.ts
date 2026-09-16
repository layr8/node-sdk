// The node pushes a replacement delegated set to a live borrowed child. These
// are the consumer-side boundary tests for that push.
//
// The fake node below speaks the wire shape the node's own channel tests
// assert: a join reply whose `delegated_credentials` carries `revision: 0`, the
// capability `ephemeral_delegation_refresh/1`, and a push on the child's own
// topic with event `delegated_credentials` and payload
// `{revision, status, credentials}`.
//
// Assertions read the attachments off the WIRE, not only the accessor: the
// wallet is what reaches the node, and a push that updated the reading but not
// the wallet would be two answers to one question.

import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Layr8Client, type DelegatedCredentialsReading, type ErrorHandler } from "../src/index.js";
import { parseDelegationPush } from "../src/channel.js";
import { Wallet } from "../src/wallet.js";

const PARENT = "did:web:example.com:agents:parent";
const CHILD = `${PARENT}:k7m2q9x4h3bd`;
const SECOND_CHILD = `${PARENT}:p4w8n2c6r1tz`;
const PROTO = "https://layr8.io/protocols/echo/1.0";
const PEER = "did:web:example.com:agents:peer";

const jwt = (payload: unknown) =>
  `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

/** A minted child in the node's wire shape, covering PROTO. */
const child = (parentId: string) => {
  const id = `child-of-${parentId}`;
  return {
    id,
    parent_capability: parentId,
    credential_jwt: jwt({
      id,
      credentialSubject: {
        scope: [{ protocol: PROTO, messageTypes: ["*"] }],
        delegation: { parentCapability: parentId },
      },
    }),
  };
};

const REFRESH_CAP = "ephemeral_delegation_refresh/1";

class FakeNode {
  readonly http: Server;
  readonly wss: WebSocketServer;
  private socket: WS | null = null;
  readonly frames: Array<{ topic: string; event: string; payload: Record<string, unknown> }> = [];
  capabilities: string[] = ["ephemeral_delegation/1", REFRESH_CAP];
  /** The join reply's reading, per joining DID. `undefined` = key omitted. */
  joinReading: (did: string) => Record<string, unknown> | undefined = () => ({
    status: "complete",
    credentials: [child("urn:uuid:p1")],
    revision: 0,
  });
  /** Hold every credential REST read until `releaseReads` — see the race test. */
  holdReads = false;
  private held: Array<() => void> = [];

  constructor() {
    this.http = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/v1/credentials")) {
        const answer = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ credentials: [] }));
        };
        if (this.holdReads) this.held.push(answer);
        else answer();
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws: WS) => {
      this.socket = ws;
      ws.on("message", (data: Buffer) => {
        const [joinRef, ref, topic, event, payload] = JSON.parse(data.toString()) as [
          string | null, string | null, string, string, Record<string, unknown>,
        ];
        this.frames.push({ topic, event, payload });
        if (event === "phx_join") {
          const did = topic.replace("plugins:", "");
          const reading = this.joinReading(did);
          const response: Record<string, unknown> = { did, capabilities: this.capabilities };
          if (reading !== undefined) response.delegated_credentials = reading;
          ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response }]));
          return;
        }
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

  /** Push `delegated_credentials` on `did`'s topic, as the node's channel does. */
  pushReading(did: string, payload: unknown): void {
    this.socket?.send(JSON.stringify([null, null, `plugins:${did}`, "delegated_credentials", payload]));
  }

  releaseReads(): void {
    const held = this.held;
    this.held = [];
    for (const answer of held) answer();
  }

  joinPayloads(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.event === "phx_join").map((f) => f.payload);
  }

  messages(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.event === "message").map((f) => f.payload);
  }

  close(): Promise<void> {
    this.releaseReads();
    return new Promise((r) => this.wss.close(() => this.http.close(() => r())));
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

const discard: ErrorHandler = () => {};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function borrowed(prepare?: (n: FakeNode) => void): Promise<Layr8Client> {
  node = new FakeNode();
  prepare?.(node);
  const nodeUrl = await node.url();
  client = new Layr8Client(discard, {
    nodeUrl,
    apiKey: "test-api-key",
    agentDid: CHILD,
    didSpec: { mode: "Create", storage: "ephemeral", parentDid: PARENT },
  });
  await client.connect();
  return client;
}

/** Ids of the attachments on the message this call sends. */
async function attachedIds(c: Layr8Client): Promise<string[]> {
  await c.send({ to: [PEER], type: `${PROTO}/note`, body: {} } as never, { fireAndForget: true });
  await tick();
  const msg = node!.messages().at(-1)!;
  return ((msg.attachments as Array<{ id: string }> | undefined) ?? []).map((a) => a.id);
}

describe("opt-in at join", () => {
  it("sends delegation_refresh: true only on a join that names a parent", async () => {
    const c = await borrowed();
    expect(node!.joinPayloads()[0].delegation_refresh).toBe(true);

    await c.joinDid("did:web:example.com:agents:standalone", { protocols: [PROTO] });
    const unparented = node!.joinPayloads()[1];
    expect("delegation_refresh" in unparented).toBe(false);
  });

  it("reports the node capability, and false when the node does not announce it", async () => {
    const c = await borrowed();
    expect(c.supportsEphemeralDelegationRefresh()).toBe(true);
    await c.close();
    await node!.close();

    const old = await borrowed((n) => {
      n.capabilities = ["ephemeral_delegation/1"];
    });
    expect(old.supportsEphemeralDelegationRefresh()).toBe(false);
    expect(old.supportsEphemeralDelegation()).toBe(true);
  });
});

describe("a push replaces the whole set", () => {
  it("applies to the reading, the wallet on the wire, and the delegation event", async () => {
    const c = await borrowed();
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p1"]);

    const events: Array<[string, DelegatedCredentialsReading]> = [];
    c.on("delegation", (did: string, reading: DelegatedCredentialsReading) => events.push([did, reading]));

    node!.pushReading(CHILD, {
      revision: 1,
      status: "complete",
      credentials: [child("urn:uuid:p2")],
    });
    await tick();

    const replaced = { status: "complete", credentials: [child("urn:uuid:p2")] };
    expect(c.delegatedCredentials()).toEqual(replaced);
    expect(events).toEqual([[CHILD, replaced]]);
    // Replaced, never appended: p1's child is gone from the wire.
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p2"]);
  });

  it("complete with [] is applied: the parent now holds nothing", async () => {
    const c = await borrowed();
    node!.pushReading(CHILD, { revision: 1, status: "complete", credentials: [] });
    await tick();

    expect(c.delegatedCredentials()).toEqual({ status: "complete", credentials: [] });
    expect(await attachedIds(c)).toEqual([]);
  });

  it("corrects a join whose reading was unread", async () => {
    const c = await borrowed((n) => {
      n.joinReading = () => ({ status: "unread", credentials: [], revision: 0 });
    });
    node!.pushReading(CHILD, { revision: 1, status: "partial", credentials: [child("urn:uuid:p3")] });
    await tick();

    expect(c.delegatedCredentials()).toEqual({ status: "partial", credentials: [child("urn:uuid:p3")] });
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p3"]);
  });

  it("reaches a DID joined with joinDid, on its own handle only", async () => {
    const c = await borrowed((n) => {
      n.joinReading = (did) => ({
        status: "complete",
        credentials: [child(did === CHILD ? "urn:uuid:p1" : "urn:uuid:s1")],
        revision: 0,
      });
    });
    const handle = await c.joinDid(SECOND_CHILD, {
      protocols: [PROTO],
      didSpec: { mode: "Create", storage: "ephemeral", parentDid: PARENT },
    });
    expect(node!.joinPayloads()[1].delegation_refresh).toBe(true);
    expect(handle.supportsEphemeralDelegationRefresh()).toBe(true);

    const events: string[] = [];
    c.on("delegation", (did: string) => events.push(did));

    node!.pushReading(SECOND_CHILD, { revision: 1, status: "complete", credentials: [child("urn:uuid:s2")] });
    await tick();

    expect(handle.delegatedCredentials()).toEqual({ status: "complete", credentials: [child("urn:uuid:s2")] });
    expect(c.delegatedCredentials()).toEqual({ status: "complete", credentials: [child("urn:uuid:p1")] });
    expect(events).toEqual([SECOND_CHILD]);
  });
});

describe("a push that is not applied leaves the last reading standing", () => {
  it("ignores a revision that is not newer than the one held", async () => {
    const c = await borrowed();
    node!.pushReading(CHILD, { revision: 2, status: "complete", credentials: [child("urn:uuid:p2")] });
    await tick();

    const events: unknown[] = [];
    c.on("delegation", (...args: unknown[]) => events.push(args));

    // Late (1) and repeated (2): both are older news than what is held.
    node!.pushReading(CHILD, { revision: 1, status: "complete", credentials: [child("urn:uuid:stale")] });
    node!.pushReading(CHILD, { revision: 2, status: "complete", credentials: [child("urn:uuid:dup")] });
    await tick();

    expect(c.delegatedCredentials()).toEqual({ status: "complete", credentials: [child("urn:uuid:p2")] });
    expect(events).toEqual([]);
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p2"]);
  });

  it("ignores a push that does not parse, and an unread push", async () => {
    const c = await borrowed();
    const events: unknown[] = [];
    c.on("delegation", (...args: unknown[]) => events.push(args));

    for (const bad of [
      null,
      [child("urn:uuid:x")],
      { revision: 1, credentials: [child("urn:uuid:x")] },
      { revision: 1, status: "bogus", credentials: [] },
      { revision: 1, status: "complete" },
      { status: "complete", credentials: [] },
      { revision: "1", status: "complete", credentials: [] },
      { revision: -1, status: "complete", credentials: [] },
      { revision: 1.5, status: "complete", credentials: [] },
      // Never sent by the node: a failed read pushes nothing. Applying it
      // would replace a real reading with an [] that measures nothing.
      { revision: 1, status: "unread", credentials: [] },
    ]) {
      node!.pushReading(CHILD, bad);
    }
    await tick();

    expect(c.delegatedCredentials()).toEqual({ status: "complete", credentials: [child("urn:uuid:p1")] });
    expect(events).toEqual([]);
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p1"]);
  });

  it("ignores a push on a join that did not opt in", async () => {
    node = new FakeNode();
    client = new Layr8Client(discard, {
      nodeUrl: await node.url(),
      apiKey: "test-api-key",
      agentDid: CHILD,
    });
    await client.connect();
    expect("delegation_refresh" in node.joinPayloads()[0]).toBe(false);
    const before = client.delegatedCredentials();
    expect(before).toEqual({ status: "complete", credentials: [child("urn:uuid:p1")] });

    node.pushReading(CHILD, { revision: 1, status: "complete", credentials: [] });
    await tick();

    expect(client.delegatedCredentials()).toBe(before);
  });

  it("no push means the join reading still stands", async () => {
    const c = await borrowed();
    await tick(60);
    expect(c.delegatedCredentials()).toEqual({ status: "complete", credentials: [child("urn:uuid:p1")] });
    expect(await attachedIds(c)).toEqual(["child-of-urn:uuid:p1"]);
  });

  it("a throwing delegation listener goes to onError and does not stop the socket", async () => {
    const errors: unknown[] = [];
    node = new FakeNode();
    client = new Layr8Client((e) => errors.push(e), {
      nodeUrl: await node.url(),
      apiKey: "test-api-key",
      agentDid: CHILD,
      didSpec: { mode: "Create", storage: "ephemeral", parentDid: PARENT },
    });
    await client.connect();
    client.on("delegation", () => {
      throw new Error("listener broke");
    });

    node.pushReading(CHILD, { revision: 1, status: "complete", credentials: [child("urn:uuid:p2")] });
    node.pushReading(CHILD, { revision: 2, status: "complete", credentials: [child("urn:uuid:p3")] });
    await tick();

    expect(errors).toHaveLength(2);
    expect(client.delegatedCredentials()?.credentials).toEqual([child("urn:uuid:p3")]);
  });
});

describe("a rejoin starts the revision again", () => {
  it("applies revision 1 after a rejoin even though revision 3 was applied before", async () => {
    const c = await borrowed();
    node!.pushReading(CHILD, { revision: 3, status: "complete", credentials: [child("urn:uuid:p3")] });
    await tick();
    expect(c.delegatedCredentials()?.credentials).toEqual([child("urn:uuid:p3")]);

    // Rejoin the primary Channel directly: this is what the reconnect loop
    // calls, without timing a real socket drop.
    const channel = (c as unknown as { primaryChannel: { rejoin(): Promise<void> } }).primaryChannel;
    await channel.rejoin();
    expect(c.delegatedCredentials()?.credentials).toEqual([child("urn:uuid:p1")]);

    node!.pushReading(CHILD, { revision: 1, status: "complete", credentials: [child("urn:uuid:p4")] });
    await tick();
    expect(c.delegatedCredentials()?.credentials).toEqual([child("urn:uuid:p4")]);
  });
});

describe("a send racing a push uses one set, never a mix", () => {
  it("a send already choosing attachments keeps the set it started with", async () => {
    // Two parent grants on each side, so a mix (one old, one new) is visible.
    const target = { recipients: [PEER], typeUri: `${PROTO}/note` };
    let release!: () => void;
    const reader = {
      get: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = () => resolve({ credentials: [] });
          }),
      ),
    } as unknown as { get<T>(p: string): Promise<T> };
    const w = new Wallet(reader);
    w.seed(CHILD, [child("urn:uuid:old-a"), child("urn:uuid:old-b")]);

    const inflight = w.attachmentsFor(CHILD, target);
    // The push lands while the send is waiting on its REST read.
    w.seed(CHILD, [child("urn:uuid:new-a"), child("urn:uuid:new-b")]);
    release();

    expect((await inflight).map((a) => a.id).sort()).toEqual([
      "child-of-urn:uuid:old-a",
      "child-of-urn:uuid:old-b",
    ]);
    expect((await w.attachmentsFor(CHILD, target)).map((a) => a.id).sort()).toEqual([
      "child-of-urn:uuid:new-a",
      "child-of-urn:uuid:new-b",
    ]);
  });

  it("end to end: a send parked on its read, then a push, puts the whole old set on the wire", async () => {
    const c = await borrowed((n) => {
      n.joinReading = () => ({
        status: "complete",
        credentials: [child("urn:uuid:old-a"), child("urn:uuid:old-b")],
        revision: 0,
      });
      n.holdReads = true;
    });

    const sending = c.send({ to: [PEER], type: `${PROTO}/note`, body: {} } as never, {
      fireAndForget: true,
    });
    await tick();
    node!.pushReading(CHILD, {
      revision: 1,
      status: "complete",
      credentials: [child("urn:uuid:new-a"), child("urn:uuid:new-b")],
    });
    await tick();
    node!.holdReads = false;
    node!.releaseReads();
    await sending;
    await tick();

    const first = (node!.messages()[0].attachments as Array<{ id: string }>).map((a) => a.id).sort();
    expect(first).toEqual(["child-of-urn:uuid:old-a", "child-of-urn:uuid:old-b"]);
    // The next send reads the cached (empty) REST answer and the new set.
    expect((await attachedIds(c)).sort()).toEqual(["child-of-urn:uuid:new-a", "child-of-urn:uuid:new-b"]);
  });
});

describe("parseDelegationPush", () => {
  it("keeps readings pairwise distinct and never turns a bad payload into complete-empty", () => {
    const completeEmpty = parseDelegationPush({ revision: 1, status: "complete", credentials: [] });
    const completeSome = parseDelegationPush({ revision: 1, status: "complete", credentials: [child("urn:uuid:a")] });
    const partial = parseDelegationPush({ revision: 1, status: "partial", credentials: [child("urn:uuid:a")] });
    const unread = parseDelegationPush({ revision: 1, status: "unread", credentials: [] });

    expect(completeEmpty).toEqual({ revision: 1, reading: { status: "complete", credentials: [] } });
    expect(completeSome).not.toEqual(completeEmpty);
    expect(partial).not.toEqual(completeSome);
    expect(partial).not.toEqual(completeEmpty);
    expect(unread).toBeUndefined();
  });
});
