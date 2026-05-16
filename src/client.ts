import { EventEmitter } from "node:events";
import type { Config } from "./config.js";
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
import type { InternalMessage, Message } from "./message.js";
import {
  generateId,
  marshalDIDComm,
  parseDIDComm,
} from "./message.js";
import { PhoenixChannel } from "./channel.js";
import { RestClient, restUrlFromWebSocket } from "./rest.js";

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

/**
 * Layr8Client is the main entry point for interacting with the Layr8 platform.
 *
 * Lifecycle: new Layr8Client → handle (register handlers) → connect → ... → close
 *
 * Extends EventEmitter for "disconnect" and "reconnect" events.
 */
export class Layr8Client extends EventEmitter {
  private readonly cfg;
  private readonly onError: ErrorHandler;
  private readonly registry = new HandlerRegistry();
  private channel: PhoenixChannel | null = null;
  private connected = false;
  private isClosed = false;
  private agentDid: string;
  private readonly rest: RestClient;

  /** Correlation map for Request/Response pattern: threadId → {resolve, reject} */
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

  /** The agent's DID — either provided in Config or assigned by the node on connect(). */
  get did(): string {
    return this.agentDid;
  }

  /**
   * Register a handler for a DIDComm message type.
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
   * Register a catch-all handler for any message type not matched by a specific handler.
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
   * Establish WebSocket connection and join the Phoenix Channel
   * with protocols derived from registered handlers.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) throw new AlreadyConnectedError();
    if (this.isClosed) throw new ClientClosedError();

    const protocols = this.registry.protocols();

    // Always subscribe to the problem-report protocol so nodes can deliver
    // problem reports back to us (e.g., when B is disconnected or passes).
    const PROBLEM_REPORT_PROTOCOL = "https://didcomm.org/report-problem/2.0";
    if (!protocols.includes("*") && !protocols.includes(PROBLEM_REPORT_PROTOCOL)) {
      protocols.push(PROBLEM_REPORT_PROTOCOL);
    }

    const channel = new PhoenixChannel(
      this.cfg.nodeUrl,
      this.cfg.apiKey,
      this.cfg.agentDid,
      {
        onMessage: (payload) => this.handleInboundMessage(payload),
        onDisconnect: (err) => this.emit("disconnect", err),
        onReconnect: () => this.emit("reconnect"),
      },
      this.cfg.didSpec,
    );

    await channel.connect(protocols, signal);

    // If no DID was provided, use the one assigned by the node
    if (!this.agentDid && channel.assignedDID()) {
      this.agentDid = channel.assignedDID();
    }

    this.channel = channel;
    this.connected = true;
  }

  /** Gracefully shut down the client connection. */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connected = false;

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    // Reject all pending requests
    for (const [threadId, pending] of this.pending) {
      pending.reject(new ClientClosedError());
      this.pending.delete(threadId);
    }
  }

  /**
   * Send a message. By default waits for server acknowledgment.
   * Pass `{ fireAndForget: true }` to skip waiting for the server reply.
   */
  async send(msg: Partial<Message>, opts?: SendOptions): Promise<void> {
    if (!this.connected || !this.channel) {
      throw new NotConnectedError();
    }

    const internal = this.fillMessage(msg);

    if (opts?.fireAndForget) {
      this.sendMessageFireAndForget(internal);
      return;
    }

    await this.sendMessageAcked(internal);
  }

  /**
   * Send a message and wait for a correlated response.
   * Throws on timeout (AbortSignal), ProblemReportError, or NotConnectedError.
   */
  async request(
    msg: Partial<Message>,
    opts?: RequestOptions,
  ): Promise<Message> {
    if (!this.connected || !this.channel) {
      throw new NotConnectedError();
    }

    const internal = this.fillMessage(msg);
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

          // Check if response is a problem report
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

      this.emit("outbound", internal);
      this.channel!.send("message", JSON.parse(marshalDIDComm(internal)))
        .then((reply) => {
          if (reply.status === "error") {
            cleanup();
            reject(new ServerRejectError(reply.reason || reply.status));
            return;
          }
          // Server accepted, keep waiting for DIDComm response
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });
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

  private sendReplyMessage(resp: Partial<Message>, original: InternalMessage): void {
    try {
      const internal = this.fillMessage(resp);
      if (!internal.to.length && original.from) {
        internal.to = [original.from];
      }
      if (!internal.threadId) {
        internal.threadId = original.threadId || original.id;
      }
      this.sendMessage(internal);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.TransportWrite, {
        messageId: original.id,
        type: original.type,
        from: original.from,
        cause: toError(err),
      }));
    }
  }

  private handleInboundMessage(payload: unknown): void {
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

    // Observability hook before dispatch — observers see every parsed message
    // regardless of how it gets routed. A throwing listener must NOT break
    // dispatch (e.g. cause a pending request() to hang).
    this.safeEmit("inbound", msg);

    // Check if this is a response to a pending Request (by thread ID).
    // For most replies the responder reuses our thid → match by threadId.
    // For DIDComm 2 problem-reports (and other corrective protocols) the
    // responder typically sets pthid = our thid and starts a fresh thid
    // for the report itself; match by parentThreadId in that case.
    const matchKey =
      (msg.threadId && this.pending.has(msg.threadId)) ? msg.threadId :
      (msg.parentThreadId && this.pending.has(msg.parentThreadId)) ? msg.parentThreadId :
      undefined;
    if (matchKey) {
      const pending = this.pending.get(matchKey);
      if (pending) {
        this.pending.delete(matchKey);
        // Send dispatch_reply so the node's PluginRouter doesn't time out
        // Send dispatch_reply so the node's PluginRouter doesn't time out.
        // Only when the node advertises reply_protocol — legacy nodes don't
        // recognize the event and may drop the connection.
        if (this.channel!.replyProtocol()) {
          this.sendDispatchReply(msg.id, "handled");
        }
        pending.resolve(msg);
        return;
      }
    }

    const useReplyProtocol = this.channel!.replyProtocol();

    // Route to registered handler
    const entry = this.registry.lookup(msg.type);
    if (!entry) {
      if (useReplyProtocol) {
        this.sendDispatchReply(msg.id, "pass");
      }
      this.onError(new SDKError(ErrorKind.NoHandler, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
      }));
      return;
    }

    if (useReplyProtocol) {
      // New mode: no ack, use dispatch_reply after handler
      this.runHandlerWithReply(entry.fn, msg);
    } else {
      // Legacy mode: ack before handler
      if (!entry.manualAck) {
        try {
          this.channel!.sendAck([msg.id]);
        } catch {
          // Best-effort ack
        }
      } else {
        msg.ackFn = (id: string) => {
          this.channel!.sendAck([id]);
        };
      }
      this.runHandler(entry.fn, msg);
    }
  }

  private async runHandler(
    fn: HandlerFn,
    msg: InternalMessage,
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
      this.sendProblemReport(msg, error);
      return;
    }

    if (resp && resp !== PASS) {
      this.sendReplyMessage(resp as Partial<Message>, msg);
    }
  }

  private async runHandlerWithReply(
    fn: HandlerFn,
    msg: InternalMessage,
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
      this.sendDispatchReply(msg.id, "error", error.name, error.message);
      return;
    }

    if (resp === PASS) {
      this.sendDispatchReply(msg.id, "pass");
      return;
    }

    // Send dispatch_reply BEFORE the response message. The node's channel
    // processes WebSocket events sequentially; if the response targets a
    // remote node, the channel blocks during HTTP delivery. Sending
    // dispatch_reply first ensures the PluginRouter's receive unblocks
    // before that blocking send.
    this.sendDispatchReply(msg.id, "handled");

    if (resp) {
      this.sendReplyMessage(resp as Partial<Message>, msg);
    }
  }

  private sendDispatchReply(
    messageId: string,
    status: string,
    code?: string,
    message?: string,
  ): void {
    try {
      const payload: Record<string, string> = { message_id: messageId, status };
      if (code) payload.code = code;
      if (message) payload.message = message;
      this.channel!.sendFireAndForget("dispatch_reply", payload);
    } catch {
      // Best-effort
    }
  }

  private sendProblemReport(original: InternalMessage, err: Error): void {
    try {
      const threadId = original.threadId || original.id;
      const report: InternalMessage = {
        id: generateId(),
        type: "https://didcomm.org/report-problem/2.0/problem-report",
        from: this.agentDid,
        to: original.from ? [original.from] : [],
        threadId,
        parentThreadId: "",
        body: {
          code: "e.p.xfer.cant-process",
          comment: err.message,
        },
      };
      this.sendMessage(report);
    } catch {
      // Best-effort: if we can't send the problem report (e.g., connection
      // lost), swallow the error to avoid masking the original handler failure.
    }
  }

  private fillMessage(msg: Partial<Message>): InternalMessage {
    return {
      id: msg.id || generateId(),
      type: msg.type || "",
      from: msg.from || this.agentDid,
      to: msg.to || [],
      threadId: msg.threadId || "",
      parentThreadId: msg.parentThreadId || "",
      body: msg.body ?? null,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    };
  }

  private async sendMessageAcked(msg: InternalMessage): Promise<void> {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.safeEmit("outbound", msg);
    const reply = await this.channel.send("message", JSON.parse(data));
    if (reply.status === "error") {
      throw new ServerRejectError(reply.reason || reply.status);
    }
  }

  private sendMessageFireAndForget(msg: InternalMessage): void {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.safeEmit("outbound", msg);
    this.channel.sendFireAndForget("message", JSON.parse(data));
  }

  private sendMessage(msg: InternalMessage): void {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.safeEmit("outbound", msg);
    this.channel.sendFireAndForget("message", JSON.parse(data));
  }
}
