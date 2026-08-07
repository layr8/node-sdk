import { EventEmitter } from "node:events";
import type { Config, DidSpec, GrantMissInfo } from "./config.js";
import { resolveConfig } from "./config.js";
import type {
  Credential,
  CredentialFormat,
  SignCredentialOptions,
  VerifiedCredential,
  VerifyCredentialOptions,
  StoreCredentialOptions,
  StoredCredential,
  ListCredentialsOptions,
} from "./credentials.js";
import type {
  SignPresentationOptions,
  VerifiedPresentation,
  VerifyPresentationOptions,
} from "./presentations.js";
import {
  AlreadyConnectedError,
  ClientClosedError,
  ErrorKind,
  NotConnectedError,
  ProblemReportError,
  SDKError,
  ServerRejectError,
} from "./errors.js";
import type { ErrorHandler } from "./errors.js";
import type { HandlerFn, HandlerOptions } from "./handler.js";
import { HandlerRegistry, PASS } from "./handler.js";
import type { Attachment, InternalMessage, Message } from "./message.js";
import {
  generateId,
  marshalDIDComm,
  parseDIDComm,
} from "./message.js";
import { Connection } from "./connection.js";
import { Channel, type ServerReply } from "./channel.js";
import { RestClient, restUrlFromWebSocket } from "./rest.js";
import { McpBinding, DEFAULT_MCP_BASE } from "./mcp.js";
import { Wallet } from "./wallet.js";

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Options for request(). */
export interface RequestOptions {
  /** Set pthid for nested thread correlation. */
  parentThread?: string;
  /** AbortSignal for timeout/cancellation control. */
  signal?: AbortSignal;
}

/** Options for send(). */
export interface SendOptions {
  /** Skip waiting for server acknowledgment. */
  fireAndForget?: boolean;
}

/** Per-DID handler entry passed to `joinDid`. */
export interface JoinDidHandler {
  fn: HandlerFn;
  manualAck?: boolean;
}

/** Options for `joinDid`. */
export interface JoinDidOptions {
  /** Protocols this Channel will subscribe to (cloud-node `payload_types`). */
  protocols: string[];
  /**
   * Per-DID handlers. A handler registered here fires for messages received
   * on THIS DID's Channel; the client-global registry (`client.handle(...)`)
   * is the fallback when this map has no entry for the inbound type.
   *
   * Accepts a bare `HandlerFn` for the auto-ack default, or
   * `{ fn, manualAck }` to opt into manual acknowledgement.
   */
  handlers?: Record<string, HandlerFn | JoinDidHandler>;
  /** DID spec for the join's `did_spec` payload (matches the global Config shape). */
  didSpec?: DidSpec;
  /** Abort the join. */
  signal?: AbortSignal;
}

/**
 * Handle for an additional DID hosted on the Layr8Client's WebSocket.
 * Returned by `Layr8Client.joinDid`.
 *
 * The handle is the per-DID counterpart to `Layr8Client.send` /
 * `client.request` / `client.sendAck`: all of those operate on the primary
 * DID (the one passed to `connect()`); a `DidHandle.send` operates on its
 * own Channel and stamps `from = this.did` on outbound messages.
 */
export class DidHandle {
  constructor(
    /** @internal */ readonly _client: Layr8Client,
    /** @internal */ readonly _channel: Channel,
  ) {}

  /** The DID this handle hosts. */
  get did(): string {
    return this._channel.did;
  }

  /**
   * Send a message FROM this DID. By default waits for server
   * acknowledgment. Pass `{ fireAndForget: true }` to skip.
   */
  async send(msg: Partial<Message>, opts?: SendOptions): Promise<void> {
    return this._client._sendOnChannel(this._channel, msg, opts);
  }

  /**
   * Send a message FROM this DID and wait for a correlated response on the
   * SAME DID's Channel.
   */
  async request(
    msg: Partial<Message>,
    opts?: RequestOptions,
  ): Promise<Message> {
    return this._client._requestOnChannel(this._channel, msg, opts);
  }

  /** Ack inbound message ids on this DID's Channel. */
  sendAck(ids: string[]): void {
    this._channel.sendAck(ids);
  }
}

/**
 * Layr8Client is the main entry point for interacting with the Layr8 platform.
 *
 * Lifecycle: `new Layr8Client` → `handle` (register handlers) → `connect`
 * → (optionally `joinDid` to host additional DIDs) → ... → `close`.
 *
 * Extends EventEmitter for "disconnect", "reconnect", "inbound" and
 * "outbound" events.
 */
/** The one inbound type `noteDenial` cares about. */
const PROBLEM_REPORT_TYPE = "https://didcomm.org/report-problem/2.0/problem-report";

/**
 * How long a message sent with nothing attached is kept, waiting for a denial.
 *
 * The node evaluates before it delivers, so the denial follows its message by a
 * round trip — one second would cover it. A minute is chosen to survive a
 * paused process or a reconnect, and it is what bounds the map: see
 * `rememberUnattached`.
 */
const UNATTACHED_WINDOW_MS = 60_000;

export class Layr8Client extends EventEmitter {
  private readonly cfg;
  private readonly onError: ErrorHandler;
  private readonly wallet: Wallet | null;
  /** Per-channel write chain — see `ordered`. */
  private readonly writeChains = new WeakMap<Channel, Promise<void>>();
  /**
   * Messages that went out with nothing attached, keyed by thread, so a denial
   * can be matched back to them. Bounded — this is a diagnostic, not a ledger.
   */
  private readonly unattached = new Map<string, { at: number; to: string[]; type: string }>();
  /** Told when a message went out with no covering grant — see `withGrants`. */
  private readonly onGrantMiss?: (info: GrantMissInfo) => void;
  private readonly registry = new HandlerRegistry();

  private connection: Connection | null = null;
  /** Primary DID's Channel (joined via `connect()`). */
  private primaryChannel: Channel | null = null;
  /** Additional DIDs joined via `joinDid()`, keyed by DID. */
  private readonly didChannels = new Map<string, Channel>();
  /** Per-DID handler registries — keyed by DID. */
  private readonly didHandlers = new Map<string, HandlerRegistry>();

  private connected = false;
  private isClosed = false;
  private agentDid: string;
  private readonly rest: RestClient;

  /** Correlation map for Request/Response: threadId → {resolve, reject}. */
  private readonly pending = new Map<
    string,
    { resolve: (msg: InternalMessage) => void; reject: (err: Error) => void }
  >();

  /** MCP protocol bases already subscribed via `mcp()` (idempotency guard). */
  private readonly mcpBases = new Set<string>();

  constructor(onError: ErrorHandler, cfg: Config = {}) {
    super();
    if (typeof onError !== "function") {
      throw new TypeError(
        "ErrorHandler is required: pass logErrors() or a custom (error: SDKError) => void",
      );
    }
    this.onError = onError;
    this.cfg = resolveConfig(cfg);
    this.agentDid = this.cfg.agentDid;
    this.rest = new RestClient(
      restUrlFromWebSocket(this.cfg.nodeUrl),
      this.cfg.apiKey,
    );
    // On by default. A grant the node requires and the SDK does not attach is
    // indistinguishable, from the caller's side, from a grant that was never
    // issued — and the denial names the grant, not the omission. Opting IN would
    // have left every existing agent in exactly the state that cost two teams
    // days.
    this.wallet = this.cfg.attachGrants
      ? new Wallet(this.rest, this.cfg.grantCacheMs, undefined, this.cfg.grantReadTimeoutMs)
      : null;
    this.onGrantMiss = cfg.onGrantMiss;
  }

  /**
   * Forget the cached grants for `did` (default: this agent's), so the next
   * message re-reads them.
   *
   * The cache TTL is the whole freshness story: a grant minted seconds ago is
   * invisible until it lapses. An agent that has just been TOLD it was granted
   * something — by a request/approve flow, or by a person on the other end of a
   * chat — should not have to wait out a timer it cannot see. Without this the
   * `Wallet.refresh` underneath was unreachable: the wallet is private and not
   * exported, so the only cure for a stale cache was a restart.
   */
  refreshGrants(did?: string): void {
    this.wallet?.refresh(did ?? this.agentDid);
  }

  /** The primary agent's DID — either provided in Config or assigned by the node on connect(). */
  get did(): string {
    return this.agentDid;
  }

  /**
   * Register a handler for a DIDComm message type on the client-global
   * registry. Applies to every joined DID's Channel as the fallback when
   * no per-DID handler is registered for the inbound type.
   *
   * Must be called BEFORE connect(). Throws AlreadyConnectedError after.
   */
  handle(
    msgType: string,
    fn: HandlerFn,
    opts?: HandlerOptions,
  ): void {
    if (this.connected) {
      throw new AlreadyConnectedError();
    }
    this.registry.register(msgType, fn, opts);
  }

  /**
   * Register a catch-all handler for any inbound message type that has no
   * specific handler registered via `handle()`. Internally stored on the
   * registry's catch-all slot — `registry.lookup(type)` returns it as the
   * fallback. Subscribes to the wildcard protocol (`"*"`) so the
   * cloud-node delivers traffic regardless of protocol.
   *
   * Must be called BEFORE connect(). Throws AlreadyConnectedError after.
   */
  handleAll(
    fn: HandlerFn,
    opts?: HandlerOptions,
  ): void {
    if (this.connected) {
      throw new AlreadyConnectedError();
    }
    this.registry.registerCatchAll(fn, opts);
  }

  /**
   * Set up MCP (Model Context Protocol) over DIDComm on a protocol `base` and
   * return a binding whose `peer(did)` yields a `.call(method, params)` caller.
   *
   * A peer's MCP surface is DIDComm request/reply: a request of type
   * `${base}/<method>` with a JSON-RPC body, answered by a
   * `${base}/<method>-result` message. The reply echoes the request's
   * `thread_id`, so `request()` correlates it — this binding removes the
   * boilerplate (the type, the JSON-RPC envelope, unwrapping `result`).
   *
   * Must be called BEFORE `connect()` (like `handle()`): it registers the
   * protocol subscription the cloud-node needs to deliver `${base}/*` replies.
   * Idempotent per base. Compose freely with your own `handle()` registrations.
   */
  mcp(base: string = DEFAULT_MCP_BASE): McpBinding {
    if (this.connected) throw new AlreadyConnectedError();
    if (this.isClosed) throw new ClientClosedError();
    if (!this.mcpBases.has(base)) {
      // A no-op handler whose type derives the `base` protocol subscribes the
      // client to it (see HandlerRegistry.protocols/deriveProtocol). request()
      // consumes correlated replies in dispatchInbound BEFORE handler lookup,
      // so this handler only ever fires for an *uncorrelated* `${base}/…`
      // message (none in normal request/reply use) — PASS is the safe default.
      this.registry.register(`${base}/_mcp`, () => PASS);
      this.mcpBases.add(base);
    }
    return new McpBinding(this, base);
  }

  /**
   * EventEmitter.emit() is synchronous and propagates listener exceptions.
   * For SDK-internal events that fire on hot paths (inbound dispatch,
   * outbound send), a throwing listener must NOT break the path — otherwise
   * a pending request() can hang indefinitely. Route any throw to onError.
   */
  private safeEmit(event: string, msg: InternalMessage): void {
    try {
      this.emit(event, msg);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.HandlerException, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
        cause: err instanceof Error ? err : new Error(String(err)),
      }));
    }
  }

  /**
   * Establish the WebSocket Connection and join the primary DID's Phoenix
   * Channel with protocols derived from registered handlers.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) throw new AlreadyConnectedError();
    if (this.isClosed) throw new ClientClosedError();

    const protocols = this.registry.protocols();

    // Always subscribe to the problem-report protocol so the cloud-node
    // can deliver problem reports back to us (e.g., when a peer is
    // disconnected or a handler PASSes). Skipped when a catch-all handler
    // is registered (`"*"` in the protocol list) — wildcard already
    // covers every protocol.
    const PROBLEM_REPORT_PROTOCOL = "https://didcomm.org/report-problem/2.0";
    if (!protocols.includes("*") && !protocols.includes(PROBLEM_REPORT_PROTOCOL)) {
      protocols.push(PROBLEM_REPORT_PROTOCOL);
    }

    this.connection = new Connection(this.cfg.nodeUrl, this.cfg.apiKey, {
      onDisconnect: (err) => this.emit("disconnect", err),
      onReconnect: () => this.emit("reconnect"),
    });

    try {
      await this.connection.dial(signal);
    } catch (err) {
      this.connection = null;
      throw err;
    }

    // The primary Channel's onMessage closure remembers `agentDid` AS IT IS
    // when join() resolves. For the auto-DID case the topic gets rekeyed
    // there too, and the dispatcher reads the DID from the Channel rather
    // than this closure — see `dispatchInbound`.
    const channel = new Channel(
      this.connection,
      this.cfg.agentDid,
      {
        onMessage: (payload) => this.dispatchInbound(channel, payload),
      },
      this.cfg.didSpec,
    );

    try {
      await channel.join(protocols, signal);
    } catch (err) {
      this.connection.close();
      this.connection = null;
      throw err;
    }

    if (!this.agentDid && channel.assignedDID()) {
      this.agentDid = channel.assignedDID();
    }

    this.primaryChannel = channel;
    this.connected = true;
  }

  /**
   * Join an additional Phoenix Channel for `did` over the existing
   * WebSocket. Returns a `DidHandle` for sending/receiving on that DID.
   *
   * The Connection (and primary Channel) must already be `connect()`-ed.
   * Per-DID handlers passed in `opts.handlers` fire first; the client-global
   * registry is the fallback.
   */
  async joinDid(did: string, opts: JoinDidOptions): Promise<DidHandle> {
    if (!this.connected || !this.connection) {
      throw new NotConnectedError();
    }
    if (this.isClosed) throw new ClientClosedError();
    if (did === this.agentDid) {
      throw new Error(
        "joinDid: this DID is already hosted by connect() — use client.send / client.request directly",
      );
    }
    if (this.didChannels.has(did)) {
      throw new Error(`joinDid: DID already joined: ${did}`);
    }

    // Always subscribe to the problem-report protocol on this DID so the
    // cloud-node can deliver problem reports targeted at it (mirrors the
    // auto-add in `connect()`). Skip when the caller already has it.
    const PROBLEM_REPORT_PROTOCOL = "https://didcomm.org/report-problem/2.0";
    const protocols = opts.protocols.includes(PROBLEM_REPORT_PROTOCOL)
      ? opts.protocols
      : [...opts.protocols, PROBLEM_REPORT_PROTOCOL];

    const channel = new Channel(
      this.connection,
      did,
      {
        onMessage: (payload) => this.dispatchInbound(channel, payload),
      },
      opts.didSpec,
    );

    try {
      await channel.join(protocols, opts.signal);
    } catch (err) {
      // Leave the Channel registered as cleanup — Channel.leave will
      // unregister it. Best-effort.
      try { channel.leave(); } catch { /* ignore */ }
      throw err;
    }

    this.didChannels.set(did, channel);

    if (opts.handlers && Object.keys(opts.handlers).length > 0) {
      const reg = new HandlerRegistry();
      for (const [msgType, h] of Object.entries(opts.handlers)) {
        if (typeof h === "function") {
          reg.register(msgType, h);
        } else {
          reg.register(msgType, h.fn, h.manualAck ? { manualAck: true } : undefined);
        }
      }
      this.didHandlers.set(did, reg);
    }

    return new DidHandle(this, channel);
  }

  /**
   * `phx_leave` the Channel for `did` and tear down its per-DID handlers.
   * The Connection (and other Channels) stay open. No-op if `did` was not
   * joined via `joinDid` (the primary DID can only be left via `close()`).
   */
  async leaveDid(did: string): Promise<void> {
    const channel = this.didChannels.get(did);
    if (!channel) return;
    channel.leave();
    this.didChannels.delete(did);
    this.didHandlers.delete(did);
  }

  /** Gracefully shut down the client. Leaves every Channel and closes the WS. */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connected = false;

    // Leave secondary Channels first so per-DID handlers can drain — the
    // Connection.close call below also fires `onConnectionClose` on every
    // registered Channel, so the order doesn't strictly matter, but it
    // keeps the leaveDid path symmetric.
    for (const did of Array.from(this.didChannels.keys())) {
      try {
        const ch = this.didChannels.get(did);
        ch?.leave();
      } catch { /* ignore */ }
    }
    this.didChannels.clear();
    this.didHandlers.clear();

    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.primaryChannel = null;

    // Reject all pending requests
    for (const [threadId, pending] of this.pending) {
      pending.reject(new ClientClosedError());
      this.pending.delete(threadId);
    }
  }

  /**
   * Send a message. By default waits for server acknowledgment.
   * Pass `{ fireAndForget: true }` to skip waiting for the server reply.
   *
   * Sends FROM the primary DID. For an additional DID, use the `DidHandle`
   * returned by `joinDid` instead.
   */
  async send(msg: Partial<Message>, opts?: SendOptions): Promise<void> {
    if (!this.connected || !this.primaryChannel) {
      throw new NotConnectedError();
    }
    return this._sendOnChannel(this.primaryChannel, msg, opts);
  }

  /**
   * Send a message and wait for a correlated response.
   * Throws on timeout (AbortSignal), ProblemReportError, or NotConnectedError.
   *
   * Sends FROM the primary DID. For an additional DID, use the `DidHandle`
   * returned by `joinDid` instead.
   */
  async request(
    msg: Partial<Message>,
    opts?: RequestOptions,
  ): Promise<Message> {
    if (!this.connected || !this.primaryChannel) {
      throw new NotConnectedError();
    }
    return this._requestOnChannel(this.primaryChannel, msg, opts);
  }

  // --- W3C Verifiable Credential APIs (REST, no WebSocket required) ---

  /**
   * Sign a W3C Verifiable Credential using the issuer's assertion key.
   * Defaults: issuer = client.did, format = "compact_jwt".
   */
  async signCredential(
    credential: Credential,
    options?: SignCredentialOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      credential,
      issuer_did: options?.issuerDid ?? this.agentDid,
      format: options?.format ?? "compact_jwt",
    };

    const result = await this.rest.post<{ signed_credential: string }>(
      "/api/v1/credentials/sign",
      body,
    );
    return result.signed_credential;
  }

  /**
   * Verify a signed credential using the verifier DID's assertion key.
   * Defaults: verifier = client.did.
   */
  async verifyCredential(
    signedCredential: string,
    options?: VerifyCredentialOptions,
  ): Promise<VerifiedCredential> {
    const body: Record<string, unknown> = {
      signed_credential: signedCredential,
      verifier_did: options?.verifierDid ?? this.agentDid,
    };

    return this.rest.post<VerifiedCredential>(
      "/api/v1/credentials/verify",
      body,
    );
  }

  /**
   * Store a signed credential JWT for a holder.
   * Defaults: holder = client.did.
   */
  async storeCredential(
    credentialJwt: string,
    options?: StoreCredentialOptions,
  ): Promise<StoredCredential> {
    const body: Record<string, unknown> = {
      holder_did: options?.holderDid ?? this.agentDid,
      credential_jwt: credentialJwt,
    };
    if (options?.issuerDid) {
      body.issuer_did = options.issuerDid;
    }
    if (options?.validUntil) {
      body.valid_until = options.validUntil.toISOString();
    }

    return this.rest.post<StoredCredential>("/api/v1/credentials", body);
  }

  /**
   * List all stored credentials for a holder.
   * Defaults: holder = client.did.
   */
  async listCredentials(
    options?: ListCredentialsOptions,
  ): Promise<StoredCredential[]> {
    const holderDid = options?.holderDid ?? this.agentDid;
    const path =
      "/api/v1/credentials?holder_did=" + encodeURIComponent(holderDid);

    const result = await this.rest.get<{ credentials: StoredCredential[] }>(
      path,
    );
    return result.credentials;
  }

  /** Retrieve a stored credential by ID. */
  async getCredential(credentialId: string): Promise<StoredCredential> {
    const path = "/api/v1/credentials/" + encodeURIComponent(credentialId);
    return this.rest.get<StoredCredential>(path);
  }

  // --- W3C Verifiable Presentation APIs (REST, no WebSocket required) ---

  /**
   * Sign a W3C Verifiable Presentation wrapping one or more signed credentials.
   * Uses the holder's authentication key (not assertion key).
   * Defaults: holder = client.did, format = "compact_jwt".
   */
  async signPresentation(
    credentials: string[],
    options?: SignPresentationOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      credentials,
      holder_did: options?.holderDid ?? this.agentDid,
      format: options?.format ?? "compact_jwt",
    };
    if (options?.nonce) {
      body.nonce = options.nonce;
    }

    const result = await this.rest.post<{ signed_presentation: string }>(
      "/api/v1/presentations/sign",
      body,
    );
    return result.signed_presentation;
  }

  /**
   * Verify a signed presentation using the verifier DID's authentication key.
   * Defaults: verifier = client.did.
   */
  async verifyPresentation(
    signedPresentation: string,
    options?: VerifyPresentationOptions,
  ): Promise<VerifiedPresentation> {
    const body: Record<string, unknown> = {
      signed_presentation: signedPresentation,
      verifier_did: options?.verifierDid ?? this.agentDid,
    };

    return this.rest.post<VerifiedPresentation>(
      "/api/v1/presentations/verify",
      body,
    );
  }

  // --- internal: per-Channel send/request helpers (used by DidHandle too) ---

  /** @internal */
  async _sendOnChannel(
    channel: Channel,
    msg: Partial<Message>,
    opts?: SendOptions,
  ): Promise<void> {
    const filled = this.fillMessageFrom(msg, channel.did);

    if (opts?.fireAndForget) {
      return this.ordered(channel, async () => {
        const internal = await this.withGrants(filled);
        this.safeEmit("outbound", internal);
        channel.sendFireAndForget("message", JSON.parse(marshalDIDComm(internal)));
      });
    }

    // The WRITE is ordered; the reply is awaited outside the chain, so a slow
    // acknowledgement does not hold up the next caller's message.
    let sent: Promise<ServerReply> | undefined;
    await this.ordered(channel, async () => {
      const internal = await this.withGrants(filled);
      this.safeEmit("outbound", internal);
      sent = channel.send("message", JSON.parse(marshalDIDComm(internal)));
    });

    const reply = await sent!;
    if (reply.status === "error") {
      throw new ServerRejectError(reply.reason || reply.status);
    }
  }

  /** @internal */
  async _requestOnChannel(
    channel: Channel,
    msg: Partial<Message>,
    opts?: RequestOptions,
  ): Promise<Message> {
    const filled = this.fillMessageFrom(msg, channel.did);
    if (!filled.threadId) {
      filled.threadId = generateId();
    }
    if (opts?.parentThread) {
      filled.parentThreadId = opts.parentThread;
    }
    // The thread is fixed BEFORE the grant read, so the pending entry can be
    // registered while the wallet is still working — otherwise a response that
    // beats our own bookkeeping has nowhere to land.
    const internal = filled;

    return new Promise<Message>((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }

      const cleanup = () => {
        this.pending.delete(internal.threadId);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(signal!.reason ?? new Error("aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(internal.threadId, {
        resolve: (resp: InternalMessage) => {
          cleanup();
          if (
            resp.type ===
            "https://didcomm.org/report-problem/2.0/problem-report"
          ) {
            const body = ((resp.bodyRaw ?? resp.body) ?? {}) as Record<string, unknown>;
            const attachments = ((resp as any).attachments ?? []) as unknown[];
            reject(
              new ProblemReportError(
                (body?.code as string) ?? "unknown",
                (body?.comment as string) ?? "unknown error",
                body,
                attachments,
              ),
            );
            return;
          }
          resolve(resp);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
      });

      // Ordered with every other write on this Channel — `request` awaits the
      // grant read too, so a caller who fires `request(A)` then `send(B)`
      // without awaiting is entitled to A first. The server's acknowledgement
      // is handled OUTSIDE the chain: a slow ack must not hold the next write.
      this.ordered(channel, async () => {
        const withVg = await this.withGrants(internal);
        this.safeEmit("outbound", withVg);
        channel.send("message", JSON.parse(marshalDIDComm(withVg)))
          .then((reply) => {
            if (reply.status === "error") {
              cleanup();
              reject(new ServerRejectError(reply.reason || reply.status));
              return;
            }
          })
          .catch((err) => {
            cleanup();
            reject(err);
          });
      }).catch((err: unknown) => {
        // Marshalling or the write itself failed before the server ever saw it.
        cleanup();
        reject(toError(err));
      });
    });
  }

  // --- internal: inbound dispatch ---

  /**
   * Receives one inbound frame from a Channel. Dispatch flow:
   *
   *   1. Parse the DIDComm.
   *   2. Emit `inbound` (observability hook).
   *   3. Match against the pending request map (cross-DID, by threadId /
   *      parentThreadId). Pending matches resolve here.
   *   4. Resolve the handler: per-DID registry first (if the inbound's
   *      Channel has one), then the client-global registry (which falls
   *      through to the catch-all registered via `handleAll`). Otherwise
   *      → `NoHandler`.
   *   5. Dispatch path forks on `channel.replyProtocol()`:
   *      - **reply protocol on** — no auto-ack; `runHandlerWithReply`
   *        emits `dispatch_reply` after the handler runs.
   *      - **legacy** — auto-ack on the ORIGINATING Channel before
   *        running the handler (`runHandler`).
   */
  private dispatchInbound(channel: Channel, payload: unknown): void {
    let msg: InternalMessage;
    try {
      msg = parseDIDComm(payload);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.ParseFailure, {
        cause: toError(err),
        raw: payload,
      }));
      return;
    }

    this.safeEmit("inbound", msg);
    this.noteDenial(msg);

    const useReplyProtocol = channel.replyProtocol();

    const matchKey =
      (msg.threadId && this.pending.has(msg.threadId)) ? msg.threadId :
      (msg.parentThreadId && this.pending.has(msg.parentThreadId)) ? msg.parentThreadId :
      undefined;
    if (matchKey) {
      const pending = this.pending.get(matchKey);
      if (pending) {
        this.pending.delete(matchKey);
        // Reply protocol: tell the node we handled it so PluginRouter
        // doesn't time out. Legacy nodes don't recognise the event so
        // we only send it when the capability was negotiated.
        if (useReplyProtocol) {
          this.sendDispatchReply(channel, msg.id, "handled");
        }
        pending.resolve(msg);
        return;
      }
    }

    // Per-DID first, then client-global (registry.lookup falls back to
    // the catch-all registered via `handleAll`, if any).
    const perDid = this.didHandlers.get(channel.did);
    const entry =
      (perDid && perDid.lookup(msg.type)) ?? this.registry.lookup(msg.type);
    if (!entry) {
      if (useReplyProtocol) {
        this.sendDispatchReply(channel, msg.id, "pass");
      }
      this.onError(new SDKError(ErrorKind.NoHandler, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
      }));
      return;
    }

    if (useReplyProtocol) {
      // New mode: no ack, `runHandlerWithReply` emits dispatch_reply.
      this.runHandlerWithReply(entry.fn, msg, channel);
    } else {
      // Legacy mode: ack before handler.
      if (!entry.manualAck) {
        try {
          channel.sendAck([msg.id]);
        } catch { /* best-effort */ }
      } else {
        msg.ackFn = (id: string) => {
          channel.sendAck([id]);
        };
      }
      this.runHandler(entry.fn, msg, channel);
    }
  }

  private async runHandler(
    fn: HandlerFn,
    msg: InternalMessage,
    channel: Channel,
  ): Promise<void> {
    let resp: Partial<Message> | null | undefined | typeof PASS;

    try {
      resp = await fn(msg);
    } catch (err) {
      const error = toError(err);
      this.onError(new SDKError(ErrorKind.HandlerException, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
        cause: error,
      }));
      this.sendProblemReport(msg, error, channel);
      return;
    }

    if (resp && resp !== PASS) {
      this.sendReplyMessage(resp as Partial<Message>, msg, channel);
    }
  }

  /**
   * Reply-protocol variant of `runHandler`. After the handler runs, emit
   * a `dispatch_reply` with the outcome (handled / pass / error) so the
   * cloud-node's PluginRouter can unblock — sent BEFORE any response
   * message, since the router blocks during HTTP delivery on the
   * server side and the dispatch_reply is what releases it.
   */
  private async runHandlerWithReply(
    fn: HandlerFn,
    msg: InternalMessage,
    channel: Channel,
  ): Promise<void> {
    let resp: Partial<Message> | null | undefined | typeof PASS;
    try {
      resp = await fn(msg);
    } catch (err) {
      const error = toError(err);
      this.onError(new SDKError(ErrorKind.HandlerException, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
        cause: error,
      }));
      this.sendDispatchReply(channel, msg.id, "error", error.name, error.message);
      return;
    }

    if (resp === PASS) {
      this.sendDispatchReply(channel, msg.id, "pass");
      return;
    }

    // dispatch_reply BEFORE the response message — see method comment.
    this.sendDispatchReply(channel, msg.id, "handled");
    if (resp) {
      this.sendReplyMessage(resp as Partial<Message>, msg, channel);
    }
  }

  /**
   * A handler's reply is an ordinary outbound message, evaluated at the peer's
   * node exactly like the request that prompted it — so it needs its grants
   * attached, and this path did not have them. Wiring `send` and `request` and
   * not this one leaves request/reply agents, the dominant pattern, as broken as
   * before and now silently: the miss callback was bypassed too.
   *
   * The grant read happens BEFORE `ordered` here, where `send` and `request`
   * both do it inside. That asymmetry is deliberate. Those two exist to honour
   * the CALLER's sequence — an agent that fires `send(A)` then `send(B)` without
   * awaiting is entitled to `[A, B]`, so the read has to sit inside the chain
   * and the chain has to bound it (`Config.grantReadTimeoutMs`). A handler's
   * reply has no such caller: it is dispatched from an inbound message, and
   * there is no contract that reply-to-A precedes reply-to-B or precedes
   * anything the application sends meanwhile. Reading outside the chain means a
   * slow read here delays only its own reply, and the chain still serialises the
   * WRITE so two replies cannot interleave on the wire.
   */
  private async sendReplyMessage(
    resp: Partial<Message>,
    original: InternalMessage,
    channel: Channel,
  ): Promise<void> {
    try {
      const filled = this.fillMessageFrom(resp, channel.did);
      // The recipient is defaulted BEFORE the wallet runs. A handler's reply
      // almost never names `to` — that is the whole point of replying — so
      // consulting the wallet first asks it to cover an EMPTY recipient list,
      // which nothing can, and the reply goes out bare. Silently: an empty
      // covering set is a legitimate outcome everywhere else.
      if (!filled.to.length && original.from) {
        filled.to = [original.from];
      }
      if (!filled.threadId) {
        filled.threadId = original.threadId || original.id;
      }
      const internal = await this.withGrants(filled);
      await this.ordered(channel, () => this.sendMessageOnChannel(internal, channel));
    } catch (err) {
      this.onError(new SDKError(ErrorKind.TransportWrite, {
        messageId: original.id,
        type: original.type,
        from: original.from,
        cause: toError(err),
      }));
    }
  }

  private sendDispatchReply(
    channel: Channel,
    messageId: string,
    status: string,
    code?: string,
    message?: string,
  ): void {
    try {
      const payload: Record<string, string> = { message_id: messageId, status };
      if (code) payload.code = code;
      if (message) payload.message = message;
      channel.sendFireAndForget("dispatch_reply", payload);
    } catch {
      // Best-effort — see Channel.sendFireAndForget.
    }
  }

  private sendProblemReport(
    original: InternalMessage,
    err: Error,
    channel: Channel,
  ): void {
    try {
      const threadId = original.threadId || original.id;
      const report: InternalMessage = {
        id: generateId(),
        type: "https://didcomm.org/report-problem/2.0/problem-report",
        from: channel.did || this.agentDid,
        to: original.from ? [original.from] : [],
        threadId,
        parentThreadId: "",
        body: {
          code: "e.p.xfer.cant-process",
          comment: err.message,
        },
      };
      this.sendMessageOnChannel(report, channel);
    } catch {
      // Best-effort: if we can't send the problem report (e.g., connection
      // lost), swallow the error to avoid masking the original handler failure.
    }
  }

  private fillMessageFrom(msg: Partial<Message>, fromDid: string): InternalMessage {
    return {
      id: msg.id || generateId(),
      type: msg.type || "",
      from: msg.from || fromDid || this.agentDid,
      to: msg.to || [],
      threadId: msg.threadId || "",
      parentThreadId: msg.parentThreadId || "",
      body: msg.body ?? null,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    };
  }

  /**
   * Attach the Verifiable Grants that cover this message.
   *
   * The node requires one for anything its policy does not allow outright, and
   * nothing in this SDK attached any — there was no enforcement on outgoing
   * requests because there was no mechanism. An agent connecting directly, on
   * any protocol other than MCP through the broker, sent nothing and was denied
   * with "no grant covers this call": a message that reads as "your grant is
   * misconfigured" when the truth is "no credential was ever put on the wire".
   *
   * Caller-supplied attachments WIN and are never displaced — someone passing
   * their own has a reason, and silently overriding it would be the second
   * confusing thing to happen to that message.
   *
   * A wallet failure does NOT block the send. The node is the authority on
   * whether this message needed a grant, and most traffic (discovery,
   * trust-ping, problem reports) needs none; refusing here on a transient fetch
   * error would take down calls that were never going to need us. The send
   * proceeds unattached and `onGrantMiss` says so.
   *
   * "Does not block" has to hold for a read that HANGS, not just one that fails
   * fast — a hang is the commoner production failure, and this await sits inside
   * the per-channel write chain, so an unbounded one deadlocks the whole
   * channel. The bound is `Config.grantReadTimeoutMs`, enforced on the request
   * itself, and a timeout arrives here as an ordinary read error.
   */
  private async withGrants(msg: InternalMessage): Promise<InternalMessage> {
    if (!this.wallet || msg.attachments?.length) return msg;

    try {
      const attachments = await this.wallet.attachmentsFor(
        msg.from,
        {
          recipients: msg.to ?? [],
          typeUri: msg.type,
          body: msg.body,
        },
        // The cap left credentials off. Announced at once rather than remembered
        // for a denial: unlike "nothing covered it", this is never the normal
        // shape of a message that needs no grant, and the holding that triggers
        // it will trigger it on every send until someone prunes the wallet.
        (capped) => this.onGrantMiss?.({ to: msg.to ?? [], type: msg.type, capped }),
      );

      if (attachments.length > 0) {
        return { ...msg, attachments };
      }

      // Nothing covered it — remembered, not announced.
      //
      // Announcing here fired on every message that legitimately needs no grant:
      // discovery, trust-ping, problem reports. Measured: five plain pings from
      // a client holding zero credentials produced five callbacks. For the
      // majority of agents, which hold no grants at all, that is one line per
      // outbound message — and a diagnostic that fires constantly is one nobody
      // reads when it matters.
      //
      // The signal actually wanted is "the node denied, and we had attached
      // nothing". That needs the denial, which arrives later — see
      // `noteDenial`.
      this.rememberUnattached(msg);
      return msg;
    } catch (err) {
      // A read failure IS announced immediately: unlike "nothing covered it",
      // it is never normal, and it means every subsequent send is flying blind.
      this.onGrantMiss?.({ to: msg.to ?? [], type: msg.type, error: err });
      return msg;
    }
  }

  /**
   * Evicted by AGE, not by count.
   *
   * A count cap dropped the entry that mattered. The denial for a message
   * arrives within seconds of it, but the cap counted every unattached message
   * in between — and `withGrants` records EVERY message it attaches nothing to,
   * which for the agents this feature is aimed at (the ones holding no grants at
   * all) is every discovery, trust-ping and problem report they send. Sixty-four
   * of those between the send and its denial and `onGrantMiss` never fired: the
   * one thing it exists for, lost to traffic that never needed a grant.
   *
   * Age bounds the map by SEND RATE × window instead, which is the honest bound
   * — the entries are small and the window is short, and a burst large enough to
   * matter would have to arrive inside it.
   */
  private rememberUnattached(msg: InternalMessage, now: number = Date.now()): void {
    // Insertion order is chronological and `now` never goes backwards, so the
    // stale entries are a prefix: stop at the first live one.
    for (const [key, rec] of this.unattached) {
      if (now - rec.at < UNATTACHED_WINDOW_MS) break;
      this.unattached.delete(key);
    }
    // Delete first: re-setting an existing key keeps its ORIGINAL position, and
    // one hot thread id refreshed in place would sit at the front with a fresh
    // timestamp and stop the prefix scan above from ever reaching the stale
    // entries behind it.
    const key = msg.threadId || msg.id;
    this.unattached.delete(key);
    this.unattached.set(key, { at: now, to: msg.to ?? [], type: msg.type });
  }

  /**
   * A problem report came back. If it is an authorization denial for a message
   * we sent with nothing attached, that is the one case `onGrantMiss` exists
   * for: the node names the grant it could not find, and only this side knows
   * no credential was ever on the wire.
   */
  private noteDenial(msg: InternalMessage): void {
    if (msg.type !== PROBLEM_REPORT_TYPE) return;

    const body = ((msg.bodyRaw ?? msg.body) ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    if (!code.includes("authz")) return;

    // `parentThreadId` is the one that matches in production and it is SECOND
    // only because a peer is free to use either. The node's own denial
    // (`report_problem.ex`) sets `pthid` — to the denied message's `thid` or, for
    // a message sent without one, its `id` — and sets no `thid` at all, so
    // `msg.threadId` is empty on every real denial this SDK will see.
    for (const key of [msg.threadId, msg.parentThreadId]) {
      const hit = key ? this.unattached.get(key) : undefined;
      if (hit) {
        this.unattached.delete(key as string);
        this.onGrantMiss?.({ to: hit.to, type: hit.type, denialCode: code });
        return;
      }
    }
  }

  /**
   * Outbound writes happen in CALL order, whatever the wallet does.
   *
   * Attaching put an `await` in front of every write, including the
   * fire-and-forget branch that had none. Measured: `send(A)` then `send(B)`,
   * with A's credential read the slower, arrived as `[B, A]`. Agents that emit a
   * sequence without awaiting each call are entitled to their order, and a
   * public SDK does not get to change that quietly.
   *
   * One chain per channel, so two DIDs do not block each other.
   */
  private ordered(channel: Channel, write: () => Promise<void> | void): Promise<void> {
    const prev = this.writeChains.get(channel) ?? Promise.resolve();
    // `write` runs whatever the previous one did — one failed send must not
    // stop the channel.
    const result = prev.then(write, write);
    // What must NOT happen is returning a swallowed promise: `send()` on a
    // dropped connection would resolve as though the message had gone out,
    // which is the same class of silence this whole change is about. The caller
    // gets `result` itself.
    //
    // Storing a settled-either-way copy is belt and braces — recovery already
    // comes from `write` being the rejection handler above, and a mutation that
    // stores `result` raw passes every test. It is kept so a later edit to
    // `.then(write)` cannot leave a lone rejected promise parked in the map.
    this.writeChains.set(channel, result.then(() => {}, () => {}));
    return result;
  }

  private sendMessageOnChannel(msg: InternalMessage, channel: Channel): void {
    const data = marshalDIDComm(msg);
    this.safeEmit("outbound", msg);
    channel.sendFireAndForget("message", JSON.parse(data));
  }
}
