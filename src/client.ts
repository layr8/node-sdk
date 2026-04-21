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
import { HandlerRegistry } from "./handler.js";
import type { InternalMessage, Message } from "./message.js";
import {
  generateId,
  marshalDIDComm,
  parseDIDComm,
} from "./message.js";
import { PhoenixChannel } from "./channel.js";
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
   * Establish WebSocket connection and join the Phoenix Channel
   * with protocols derived from registered handlers.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) throw new AlreadyConnectedError();
    if (this.isClosed) throw new ClientClosedError();

    const protocols = this.registry.protocols();

    const channel = new PhoenixChannel(
      this.cfg.nodeUrl,
      this.cfg.apiKey,
      this.cfg.agentDid,
      {
        onMessage: (payload) => this.handleInboundMessage(payload),
        onDisconnect: (err) => this.emit("disconnect", err),
        onReconnect: () => this.emit("reconnect"),
      },
      this.cfg.persistent,
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
            const body = (resp.bodyRaw ?? resp.body) as {
              code?: string;
              comment?: string;
            };
            reject(
              new ProblemReportError(
                body?.code ?? "unknown",
                body?.comment ?? "unknown error",
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

  private handleInboundMessage(payload: unknown): void {
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

    // Check if this is a response to a pending Request (by thread ID)
    if (msg.threadId) {
      const pending = this.pending.get(msg.threadId);
      if (pending) {
        this.pending.delete(msg.threadId);
        pending.resolve(msg);
        return;
      }
    }

    // Route to registered handler
    const entry = this.registry.lookup(msg.type);
    if (!entry) {
      this.onError(new SDKError(ErrorKind.NoHandler, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
      }));
      return;
    }

    // Auto-ack before handler (unless manual ack)
    if (!entry.manualAck) {
      try {
        this.channel!.sendAck([msg.id]);
      } catch {
        // Best-effort: swallow write failures on auto-ack to avoid
        // unhandled exceptions in the inbound message callback path.
      }
    } else {
      msg.ackFn = (id: string) => {
        this.channel!.sendAck([id]);
      };
    }

    // Run handler asynchronously
    this.runHandler(entry.fn, msg);
  }

  private async runHandler(
    fn: HandlerFn,
    msg: InternalMessage,
  ): Promise<void> {
    let resp: Partial<Message> | null | undefined;

    // 1. Run the handler — failures are HandlerException
    try {
      resp = await fn(msg);
    } catch (err) {
      this.onError(new SDKError(ErrorKind.HandlerException, {
        messageId: msg.id,
        type: msg.type,
        from: msg.from,
        cause: err instanceof Error ? err : new Error(String(err)),
      }));
      this.sendProblemReport(msg, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // 2. Send the response — failures are TransportWrite
    if (resp) {
      try {
        const internal = this.fillMessage(resp);
        if (!internal.to.length && msg.from) {
          internal.to = [msg.from];
        }
        if (!internal.threadId) {
          internal.threadId = msg.threadId || msg.id;
        }
        this.sendMessage(internal);
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
    };
  }

  private async sendMessageAcked(msg: InternalMessage): Promise<void> {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    const reply = await this.channel.send("message", JSON.parse(data));
    if (reply.status === "error") {
      throw new ServerRejectError(reply.reason || reply.status);
    }
  }

  private sendMessageFireAndForget(msg: InternalMessage): void {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.channel.sendFireAndForget("message", JSON.parse(data));
  }

  private sendMessage(msg: InternalMessage): void {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.channel.sendFireAndForget("message", JSON.parse(data));
  }
}
