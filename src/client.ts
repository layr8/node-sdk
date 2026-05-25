import { EventEmitter } from "node:events";
import type { Config, DidSpec } from "./config.js";
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
import { HandlerRegistry } from "./handler.js";
import type { InternalMessage, Message } from "./message.js";
import {
  generateId,
  marshalDIDComm,
  parseDIDComm,
} from "./message.js";
import { Connection } from "./connection.js";
import { Channel } from "./channel.js";
import { RestClient, restUrlFromWebSocket } from "./rest.js";

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
export class Layr8Client extends EventEmitter {
  private readonly cfg;
  private readonly onError: ErrorHandler;
  private readonly registry = new HandlerRegistry();
  private defaultHandler: HandlerFn | null = null;

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
   * Register a fallback handler invoked for any inbound message whose type
   * has no specific handler registered via handle(). Without this, unmatched
   * types fire ErrorKind.NoHandler via onError.
   *
   * Note: the cloud-node only delivers messages whose protocol the client has
   * subscribed to (derived from registered handle() types). The default
   * handler catches types within a subscribed protocol that lack a specific
   * handler — not arbitrary unsubscribed protocols.
   *
   * The default handler runs with auto-ack only; manualAck is not supported.
   * Use handle(type, fn, { manualAck: true }) for types that need durable
   * processing.
   *
   * Must be called BEFORE connect(). Throws AlreadyConnectedError after.
   */
  handleDefault(fn: HandlerFn): void {
    if (this.connected) {
      throw new AlreadyConnectedError();
    }
    this.defaultHandler = fn;
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

    const channel = new Channel(
      this.connection,
      did,
      {
        onMessage: (payload) => this.dispatchInbound(channel, payload),
      },
      opts.didSpec,
    );

    try {
      await channel.join(opts.protocols, opts.signal);
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
    const internal = this.fillMessageFrom(msg, channel.did);

    if (opts?.fireAndForget) {
      this.safeEmit("outbound", internal);
      const data = marshalDIDComm(internal);
      channel.sendFireAndForget("message", JSON.parse(data));
      return;
    }

    this.safeEmit("outbound", internal);
    const data = marshalDIDComm(internal);
    const reply = await channel.send("message", JSON.parse(data));
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
    const internal = this.fillMessageFrom(msg, channel.did);
    if (!internal.threadId) {
      internal.threadId = generateId();
    }
    if (opts?.parentThread) {
      internal.parentThreadId = opts.parentThread;
    }

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

      this.safeEmit("outbound", internal);
      channel.send("message", JSON.parse(marshalDIDComm(internal)))
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
   *      Channel has one), then the client-global registry, then the
   *      defaultHandler. Otherwise → `NoHandler`.
   *   5. Auto-ack on the ORIGINATING Channel (so the ack rides the same
   *      Phoenix topic) unless the handler opted into `manualAck`.
   *   6. Run the handler asynchronously.
   */
  private dispatchInbound(channel: Channel, payload: unknown): void {
    let msg: InternalMessage;
    try {
      msg = parseDIDComm(payload);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.ParseFailure, {
        cause: err instanceof Error ? err : new Error(String(err)),
        raw: payload,
      }));
      return;
    }

    this.safeEmit("inbound", msg);

    const matchKey =
      (msg.threadId && this.pending.has(msg.threadId)) ? msg.threadId :
      (msg.parentThreadId && this.pending.has(msg.parentThreadId)) ? msg.parentThreadId :
      undefined;
    if (matchKey) {
      const pending = this.pending.get(matchKey);
      if (pending) {
        this.pending.delete(matchKey);
        pending.resolve(msg);
        return;
      }
    }

    // Per-DID first, then client-global.
    const perDid = this.didHandlers.get(channel.did);
    const entry =
      (perDid && perDid.lookup(msg.type)) ?? this.registry.lookup(msg.type);
    if (!entry) {
      if (this.defaultHandler) {
        try {
          channel.sendAck([msg.id]);
        } catch { /* best-effort */ }
        this.runHandler(this.defaultHandler, msg, channel);
        return;
      }
      this.onError(new SDKError(ErrorKind.NoHandler, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
      }));
      return;
    }

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

  private async runHandler(
    fn: HandlerFn,
    msg: InternalMessage,
    channel: Channel,
  ): Promise<void> {
    let resp: Partial<Message> | null | undefined;

    try {
      resp = await fn(msg);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.HandlerException, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
        cause: err instanceof Error ? err : new Error(String(err)),
      }));
      this.sendProblemReport(msg, err instanceof Error ? err : new Error(String(err)), channel);
      return;
    }

    if (resp) {
      try {
        const internal = this.fillMessageFrom(resp, channel.did);
        if (!internal.to.length && msg.from) {
          internal.to = [msg.from];
        }
        if (!internal.threadId) {
          internal.threadId = msg.threadId || msg.id;
        }
        this.sendMessageOnChannel(internal, channel);
      } catch (err) {
        this.onError(new SDKError(ErrorKind.TransportWrite, {
          messageId: msg.id,
          type: msg.type,
          from: msg.from,
          cause: err instanceof Error ? err : new Error(String(err)),
        }));
      }
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

  private sendMessageOnChannel(msg: InternalMessage, channel: Channel): void {
    const data = marshalDIDComm(msg);
    this.safeEmit("outbound", msg);
    channel.sendFireAndForget("message", JSON.parse(data));
  }
}
