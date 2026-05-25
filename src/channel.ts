import { Connection, type ConnectionCallbacks, type ServerReply } from "./connection.js";
import type { DidSpec } from "./config.js";
import { DEFAULT_DID_SPEC } from "./config.js";
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
 */
export interface ChannelCallbacks {
  onMessage: (payload: unknown) => void;
  onDisconnect?: (err: Error) => void;
  onReconnect?: () => void;
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
  private readonly didSpec: Required<DidSpec>;

  private joinRef = "";
  private assignedDIDVal = "";
  private protocols: string[] = [];
  private joined = false;
  private left = false;

  constructor(
    private readonly connection: Connection,
    did: string,
    callbacks: ChannelCallbacks,
    didSpec?: DidSpec,
  ) {
    this.topic = `plugins:${did}`;
    this.callbacks = callbacks;
    this.didSpec = {
      ...DEFAULT_DID_SPEC,
      ...didSpec,
      verificationMethods:
        didSpec?.verificationMethods ?? DEFAULT_DID_SPEC.verificationMethods,
    };
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

    const joinPayload = {
      payload_types: this.protocols,
      did_spec: didSpecPayload,
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
      response?: { did?: string; reason?: string };
    };
    if (reply.status !== "ok") {
      const reason =
        reply.response?.reason ?? `join rejected: ${reply.status ?? "unknown"}`;
      throw new ConnectionError(this.topic, reason);
    }
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

  close(): void {
    this.connection.close();
    this.channel = null;
  }
}
