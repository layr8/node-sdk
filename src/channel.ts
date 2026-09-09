import { Connection, type ConnectionCallbacks, type ServerReply } from "./connection.js";
import type { DidSpec } from "./config.js";
import { DEFAULT_DID_SPEC } from "./config.js";
import { resolveBorrowerDid } from "./child-did.js";
import { ConnectionError, NotConnectedError } from "./errors.js";

export type { ServerReply };

/**
 * Lifecycle and inbound callbacks for one Channel.
 *
 * - `onMessage` — every inbound `message` event for this Channel's topic.
 * - `onDisconnect` — fires when the underlying Connection drops (any
 *   reason). Per-Channel notification; the Connection-level callback
 *   (`ConnectionCallbacks.onDisconnect`) also fires once for the
 *   whole socket.
 * - `onReconnect` — fires after the Connection re-dials AND this Channel
 *   has successfully re-joined.
 * - `onDelegatedCredentials` — fires after EVERY successful join and rejoin,
 *   with the reading the node returned, or `undefined` when it returned none.
 *
 *   It fires **unconditionally**, including with `undefined`, and that is the
 *   whole point of it. The node mints a fresh set on every join, so a holder
 *   of the previous set has to be told to drop it — and the case where the
 *   node returns nothing is exactly the case where the previous set is most
 *   likely to be wrong (the node rolled back, delegation was switched off, or
 *   the Channel rejoined without naming a parent). Firing only when there is
 *   something to hand over leaves the last join's credentials in the wallet
 *   while `delegatedCredentials()` reports there are none: two answers to one
 *   question, and the wallet's is the one that reaches the wire.
 */
export interface ChannelCallbacks {
  onMessage: (payload: unknown) => void;
  onDisconnect?: (err: Error) => void;
  onReconnect?: () => void;
  onDelegatedCredentials?: (
    did: string,
    reading: DelegatedCredentialsReading | undefined,
  ) => void;
}

/**
 * One credential the node signed for this DID out of what its parent holds.
 *
 * `credential_jwt` is a compact JWS, ready to attach to an outbound message as
 * `application/vc+jwt` — the same shape `GET /api/v1/credentials` returns, so
 * the wallet parses it with no special case.
 *
 * **It exists nowhere but here.** The node stores nothing about it: a
 * credential belonging to a connection has the lifetime of that connection.
 * There is no endpoint that will hand it back, and losing the join reply means
 * rejoining to be issued a new one.
 */
export interface DelegatedCredential {
  /** The credential's own `id`. */
  id: string;
  /** The parent credential it cites in `credentialSubject.delegation.parentCapability`. */
  parent_capability: string;
  /** The signed credential, as a compact JWS. */
  credential_jwt: string;
}

/**
 * How completely the node read the parent's wallet.
 *
 * - `"complete"` — it was read and every grant in it was delegated.
 *   `credentials` is the whole answer, and `[]` here is the measured statement
 *   that the parent holds no grants.
 * - `"partial"` — it was read and at least one grant could **not** be
 *   delegated. `credentials` holds the rest, and there is authority the parent
 *   has that this connection will never get. The node's log says why.
 * - `"unread"` — it could not be read at all. `credentials` is `[]` and that
 *   `[]` measures nothing.
 */
export type DelegationStatus = "complete" | "partial" | "unread";

/**
 * What one join learned about the parent's wallet.
 *
 * The node sends an object rather than a bare array precisely so that
 * `"unread"` has a value of its own. When it was an array, an unreadable
 * wallet arrived as `[]` — the same value that means "read, and it grants
 * nothing" — and that is the reassuring one of the two: a client acting on it
 * sends its messages bare and gets back a denial naming a grant.
 */
export interface DelegatedCredentialsReading {
  status: DelegationStatus;
  credentials: DelegatedCredential[];
}

const DELEGATION_STATUSES: readonly string[] = ["complete", "partial", "unread"];

/**
 * A join reply's `delegated_credentials`, or `undefined` if it is not a reading.
 *
 * Anything that is not a well-formed reading — absent, an array (an older node,
 * before `status` existed), a status this build does not know — is `undefined`,
 * which means "no reading". It is never coerced into
 * `{status: "complete", credentials: []}`: that would state that a wallet was
 * read and grants nothing, which is the one thing none of those inputs says.
 */
export function parseDelegatedCredentials(
  raw: unknown,
): DelegatedCredentialsReading | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as { status?: unknown; credentials?: unknown };
  if (typeof r.status !== "string" || !DELEGATION_STATUSES.includes(r.status)) {
    return undefined;
  }
  if (!Array.isArray(r.credentials)) return undefined;
  return {
    status: r.status as DelegationStatus,
    credentials: r.credentials as DelegatedCredential[],
  };
}

/**
 * Channel — the per-topic half of the Phoenix Channel transport.
 *
 * One Channel = one joined `plugins:<did>` topic. Multiple Channels share a
 * single Connection (and therefore a single WebSocket). The Connection
 * owns the ref counter, pending-reply table, liveness timers, and
 * reconnect loop; the Channel owns join state (joinRef, assignedDID),
 * its topic, and the inbound callbacks for messages on it.
 *
 * Construction is inert — call `join(protocols)` to send the `phx_join`.
 * Construction MUST register the Channel on the Connection (handled
 * automatically by the constructor).
 */
export class Channel {
  /**
   * The joined Phoenix topic, `plugins:<did>`. Mutable to support the
   * auto-DID path: when the Channel is constructed with an empty DID
   * (caller wants the node to assign one), the topic starts as
   * `"plugins:"` and is rewritten in `joinImpl` once the join reply
   * delivers `response.did`. The Connection's topic→Channel map is
   * re-keyed in lockstep via `Connection.rekeyChannel`.
   */
  topic: string;
  private readonly callbacks: ChannelCallbacks;
  /**
   * Whether the cloud-node negotiated the `reply_protocol/1` capability at
   * join time. Capability arrives in the `response.capabilities` array of
   * the `phx_reply` to our `phx_join`. Channel-level state because the
   * negotiation happens per-channel (each join can in principle land on a
   * different node version, though in practice the whole WS is one node).
   */
  private replyProtocolEnabled = false;
  private readonly didSpec: Required<DidSpec>;

  private joinRef = "";
  private assignedDIDVal = "";
  /**
   * `undefined` until a join reply that named a parent arrives — see
   * `delegatedCredentials()`.
   */
  private delegatedVal: DelegatedCredentialsReading | undefined;
  private ephemeralDelegationSupported = false;
  private protocols: string[] = [];
  private joined = false;
  private left = false;

  constructor(
    private readonly connection: Connection,
    did: string,
    callbacks: ChannelCallbacks,
    didSpec?: DidSpec,
  ) {
    this.callbacks = callbacks;
    const merged: Required<DidSpec> = {
      ...DEFAULT_DID_SPEC,
      ...didSpec,
      verificationMethods:
        didSpec?.verificationMethods ?? DEFAULT_DID_SPEC.verificationMethods,
    };

    // `resolveConfig` has already settled the primary Channel's DID; this
    // covers every OTHER Channel, which is handed a DID by its caller and
    // never passes through there. Both paths run the same rule, so a DID that
    // names a parent it is not beneath fails locally instead of at the join.
    const borrower = resolveBorrowerDid(did, merged.parentDid);
    merged.childNameSource = borrower.childNameSource ?? "";

    this.topic = `plugins:${borrower.did}`;
    this.didSpec = merged;
    connection.registerChannel(this);
  }

  /**
   * Send `phx_join` for this Channel's topic and wait for the reply.
   * Stores `protocols` so the Connection's reconnect loop can rejoin
   * automatically.
   */
  async join(protocols: string[], signal?: AbortSignal): Promise<void> {
    this.protocols = protocols;
    await this.joinImpl(signal);
    this.joined = true;
  }

  /**
   * Re-send `phx_join` after the Connection has re-dialed. Called by
   * `Connection.reconnectLoop`. The Channel keeps the original protocols
   * + didSpec from the original `join()` so no caller state is needed.
   */
  async rejoin(): Promise<void> {
    if (this.left) return;
    await this.joinImpl();
    this.joined = true;
  }

  /**
   * Send `phx_leave` (best-effort) and unregister from the Connection.
   * The Connection itself stays open — use `Connection.close()` to tear
   * down the WebSocket.
   */
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.joined = false;

    try {
      this.connection.writeMsg({
        joinRef: null,
        ref: this.connection.nextRef(),
        topic: this.topic,
        event: "phx_leave",
        payload: {},
      });
    } catch {
      // ignore — Connection may be mid-reconnect
    }

    this.connection.unregisterChannel(this.topic);
  }

  /**
   * Tracked send: returns a promise that resolves on the matching
   * `phx_reply`. The promise rejects on a 15-second reply timeout, on
   * disconnect, or on Connection close.
   */
  async send(event: string, payload: unknown): Promise<ServerReply> {
    if (!this.connection.isConnected() || !this.joined) {
      // `!this.joined` catches the post-reconnect window where the WS is up
      // (Connection.isConnected()=true) but this specific Channel failed
      // to rejoin (cloud-node has no subscription for this topic). Without
      // it the write would land on the wire but be silently dropped.
      throw new NotConnectedError();
    }
    const ref = this.connection.nextRef();
    const replyPromise = this.connection.trackPendingRef(ref);
    try {
      this.connection.writeMsg({
        joinRef: null,
        ref,
        topic: this.topic,
        event,
        payload,
      });
    } catch (err) {
      // The pendingRef will time out on its own, but throwing eagerly
      // is the desired user-facing behavior. The next phx_reply for this
      // ref (if any) would no-op since the map entry is gone.
      throw err;
    }
    const raw = await replyPromise;
    return normaliseServerReply(raw);
  }

  /** Fire-and-forget send: writes the frame, returns synchronously. */
  sendFireAndForget(event: string, payload: unknown): void {
    if (!this.connection.isConnected() || !this.joined) {
      // See `send` — joined-but-disconnected and reconnected-but-rejoin-
      // failed are both NotConnectedError from the caller's perspective.
      throw new NotConnectedError();
    }
    this.connection.writeMsg({
      joinRef: null,
      ref: this.connection.nextRef(),
      topic: this.topic,
      event,
      payload,
    });
  }

  /** Ack inbound message ids (fire-and-forget). */
  sendAck(ids: string[]): void {
    this.sendFireAndForget("ack", { ids });
  }

  /** DID assigned by the node when this Channel joined. "" until join replies. */
  assignedDID(): string {
    return this.assignedDIDVal;
  }

  /**
   * What this join learned about the parent's wallet, and what came back.
   *
   * **Five readings, and they are deliberately not two.** Collapsing any pair
   * of them reports something nobody measured:
   *
   * | Value | `supportsEphemeralDelegation()` | Meaning |
   * |---|---|---|
   * | `undefined` | `true`  | this join named no parent, so nothing was delegated |
   * | `{status: "complete", credentials: []}` | `true` | the parent's wallet was **read** and it holds no grants |
   * | `{status: "complete", credentials: [...]}` | `true` | read, and here is all of it |
   * | `{status: "partial", credentials: [...]}` | `true` | read, and some of it could not be delegated — there is more you did not get |
   * | `{status: "unread", credentials: []}` | `true` | the wallet could **not** be read; the `[]` measures nothing |
   * | `undefined` | `false` | the node predates delegation — it never looked |
   *
   * Do not write `delegatedCredentials()?.credentials ?? []` and treat the
   * result as the parent's grants: that turns four of those six rows into the
   * second one, and the second is the only one of them that is a measurement.
   * Read `status` first.
   *
   * A fresh reading replaces the old one on every rejoin, because the node
   * mints a fresh set per join — including a rejoin that comes back with no
   * reading at all, which clears it.
   */
  delegatedCredentials(): DelegatedCredentialsReading | undefined {
    return this.delegatedVal;
  }

  /**
   * Whether the node advertised `ephemeral_delegation/1` at join. Without it,
   * an absent `delegatedCredentials()` means the node never looked — not that
   * the parent holds nothing.
   */
  supportsEphemeralDelegation(): boolean {
    return this.ephemeralDelegationSupported;
  }

  /**
   * Whether the cloud-node supports the `reply_protocol/1` capability for
   * this Channel — set from `response.capabilities` in the join reply.
   * `false` until `join()` resolves; stays `false` if the server doesn't
   * advertise the capability.
   */
  replyProtocol(): boolean {
    return this.replyProtocolEnabled;
  }

  /** True once `join()` has resolved successfully. */
  isJoined(): boolean {
    return this.joined && !this.left;
  }

  /**
   * The DID this Channel hosts — extracted from `topic` (`plugins:<did>`).
   * For auto-DID Channels this is the empty string before `join()` and the
   * server-assigned DID after.
   */
  get did(): string {
    return this.topic.startsWith("plugins:") ? this.topic.slice("plugins:".length) : "";
  }

  // ── Connection-side hooks (called by Connection's read loop / lifecycle) ─

  /** Inbound `message` for this Channel's topic. */
  onMessage(payload: unknown): void {
    this.callbacks.onMessage(payload);
  }

  /** `phx_error` or `phx_close` for this Channel's topic. */
  onChannelTeardown(err: Error): void {
    this.callbacks.onDisconnect?.(err);
  }

  /** The Connection's WS dropped unexpectedly. */
  onUnexpectedDisconnect(err: Error): void {
    this.joined = false;
    this.callbacks.onDisconnect?.(err);
  }

  /** The Connection has re-dialed and this Channel was successfully rejoined. */
  onReconnect(): void {
    this.callbacks.onReconnect?.();
  }

  /** The Connection is being torn down — clean up per-Channel state. */
  onConnectionClose(): void {
    this.left = true;
    this.joined = false;
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Build the `phx_join` payload and write it, returning when the matching
   * `phx_reply` arrives via the Connection's `pendingRefs` table.
   *
   * On a non-"ok" status the promise rejects with `ConnectionError`. On a
   * successful reply the Channel records `assignedDID` (if the node
   * supplied one) and stores `joinRef` for outbound frame correlation.
   */
  private async joinImpl(signal?: AbortSignal): Promise<void> {
    const ref = this.connection.nextRef();
    this.joinRef = ref;

    const spec = this.didSpec;
    const didSpecPayload: Record<string, unknown> = {
      mode: spec.mode,
      storage: spec.storage,
      type: spec.type,
      verificationMethods: spec.verificationMethods,
    };
    if (spec.label) {
      didSpecPayload.label = spec.label;
    }
    if (spec.controller) {
      didSpecPayload.controller = spec.controller;
    }
    // Same shape as `controller`: sent only when set, so a join that names no
    // parent puts exactly the payload on the wire it put there before this
    // field existed.
    if (spec.parentDid) {
      didSpecPayload.parentDid = spec.parentDid;
    }
    // Sent only when a parent was named and somebody therefore chose a
    // borrower's name. An empty value is not sent at all, so "this client does
    // not report it" stays a third answer rather than becoming "the caller
    // chose it".
    if (spec.childNameSource) {
      didSpecPayload.childNameSource = spec.childNameSource;
    }

    const joinPayload = {
      payload_types: this.protocols,
      did_spec: didSpecPayload,
      reply_protocol: true,
    };

    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }

    const replyPromise = this.connection.trackPendingRef(ref);

    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        // The pending entry will resolve on its own when (and if) a reply
        // eventually arrives — set up a no-op consumer in that case.
        replyPromise.catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      this.connection.writeMsg({
        joinRef: ref,
        ref,
        topic: this.topic,
        event: "phx_join",
        payload: joinPayload,
      });
    } catch (err) {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      throw err;
    }

    let rawReply: unknown;
    try {
      rawReply = await replyPromise;
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }

    const reply = rawReply as {
      status?: string;
      response?: {
        did?: string;
        reason?: string;
        capabilities?: string[];
        delegated_credentials?: unknown;
      };
    };
    if (reply.status !== "ok") {
      const reason =
        reply.response?.reason ?? `join rejected: ${reply.status ?? "unknown"}`;
      throw new ConnectionError(this.topic, reason);
    }
    // Capability negotiation: the cloud-node echoes the capabilities it
    // accepts in `response.capabilities`. We only care about
    // `reply_protocol/1` today.
    const caps = reply.response?.capabilities ?? [];
    this.replyProtocolEnabled = caps.includes("reply_protocol/1");
    this.ephemeralDelegationSupported = caps.includes("ephemeral_delegation/1");

    // `?? []` would be the bug this field exists to avoid: the node omits the
    // key when the join named no parent, and otherwise sends a reading that
    // says whether it could read the parent's wallet at all. Only a
    // well-formed reading is a reading.
    this.delegatedVal = parseDelegatedCredentials(reply.response?.delegated_credentials);
    if (reply.response?.did) {
      this.assignedDIDVal = reply.response.did;
      // Auto-DID path: only when the Channel was constructed with an
      // empty DID (placeholder topic `"plugins:"`) do we adopt the
      // server-assigned DID as the topic. When the caller supplied a
      // DID up-front, the server-returned `response.did` is informational
      // only (it may not equal what we sent — e.g. test mocks return a
      // fixed string regardless), and we keep our own topic.
      if (this.topic === "plugins:") {
        const newTopic = `plugins:${reply.response.did}`;
        this.connection.rekeyChannel(this.topic, newTopic);
        this.topic = newTopic;
      }
    }
    // AFTER the topic rekey, because `this.did` is derived from the topic and
    // the credentials are keyed by the DID that holds them. On the auto-DID
    // path it is "" until the line above runs, and a wallet seeded under ""
    // is a wallet nothing ever reads.
    // UNCONDITIONAL, `undefined` included. A rejoin whose reply carries no
    // reading is a rejoin after which the previous set must go: it was minted
    // for a DID document this rejoin may have replaced, and the node that
    // would have re-minted it did not. Firing only when there is something to
    // hand over left the wallet attaching last join's credentials while
    // `delegatedCredentials()` reported there were none.
    this.callbacks.onDelegatedCredentials?.(this.did, this.delegatedVal);
  }
}

/** Normalise a raw phx_reply payload to ServerReply. */
function normaliseServerReply(raw: unknown): ServerReply {
  const r = (raw ?? {}) as {
    status?: string;
    response?: { reason?: string };
  };
  return {
    status: r.status ?? "",
    reason: r.response?.reason ?? "",
  };
}

/**
 * @deprecated Use `Connection` + `Channel` directly. This facade is kept
 * only so the existing `tests/channel.test.ts` integration tests (which
 * exercise the single-DID surface end-to-end against a real
 * WebSocketServer mock) continue to pass without modification while the
 * multi-channel refactor lands. Slated for removal in a follow-up PR
 * once those tests are re-targeted to the new shape.
 */
export class PhoenixChannel {
  private readonly connection: Connection;
  private channel: Channel | null = null;

  private readonly callbacks: ChannelCallbacks;
  private readonly didSpec?: DidSpec;
  private readonly agentDid: string;

  constructor(
    wsUrl: string,
    apiKey: string,
    agentDid: string,
    callbacks: ChannelCallbacks,
    didSpec?: DidSpec,
  ) {
    this.agentDid = agentDid;
    this.callbacks = callbacks;
    this.didSpec = didSpec;
    const connCallbacks: ConnectionCallbacks = {};
    if (callbacks.onDisconnect) connCallbacks.onDisconnect = callbacks.onDisconnect;
    if (callbacks.onReconnect) connCallbacks.onReconnect = callbacks.onReconnect;
    this.connection = new Connection(wsUrl, apiKey, connCallbacks);
  }

  async connect(protocols: string[], signal?: AbortSignal): Promise<void> {
    await this.connection.dial(signal);
    this.channel = new Channel(
      this.connection,
      this.agentDid,
      // The Connection already calls its own `onDisconnect` /`onReconnect`,
      // so don't double-fire from the inner Channel — only forward
      // `onMessage` for the topic.
      { onMessage: this.callbacks.onMessage },
      this.didSpec,
    );
    try {
      await this.channel.join(protocols, signal);
    } catch (err) {
      // Single-DID facade: a failed join means the whole connect() failed.
      // Tear the Connection down so the caller (and the server) see a
      // closed WS — otherwise an afterEach hung on server.close() waiting
      // for the client to disconnect.
      this.connection.close();
      this.channel = null;
      throw err;
    }
  }

  send(event: string, payload: unknown): Promise<ServerReply> {
    if (!this.channel) return Promise.reject(new NotConnectedError());
    return this.channel.send(event, payload);
  }

  sendFireAndForget(event: string, payload: unknown): void {
    if (!this.channel) throw new NotConnectedError();
    this.channel.sendFireAndForget(event, payload);
  }

  sendAck(ids: string[]): void {
    if (!this.channel) throw new NotConnectedError();
    this.channel.sendAck(ids);
  }

  assignedDID(): string {
    return this.channel?.assignedDID() ?? "";
  }

  /** See `Channel.delegatedCredentials()` — delegates to the inner Channel. */
  delegatedCredentials(): DelegatedCredentialsReading | undefined {
    return this.channel?.delegatedCredentials();
  }

  /** See `Channel.supportsEphemeralDelegation()` — delegates to the inner Channel. */
  supportsEphemeralDelegation(): boolean {
    return this.channel?.supportsEphemeralDelegation() ?? false;
  }

  /** See `Channel.replyProtocol()` — delegates to the inner Channel. */
  replyProtocol(): boolean {
    return this.channel?.replyProtocol() ?? false;
  }

  close(): void {
    this.connection.close();
    this.channel = null;
  }
}
