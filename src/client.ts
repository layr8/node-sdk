import { EventEmitter } from "node:events";
import type { Config } from "./config.js";
import { resolveConfig } from "./config.js";
import {
  AlreadyConnectedError,
  ClientClosedError,
  NotConnectedError,
  ProblemReportError,
} from "./errors.js";
import type { HandlerFn, HandlerOptions } from "./handler.js";
import { HandlerRegistry } from "./handler.js";
import type { InternalMessage, Message } from "./message.js";
import {
  generateId,
  marshalDIDComm,
  parseDIDComm,
} from "./message.js";
import { PhoenixChannel } from "./channel.js";

/** Options for request(). */
export interface RequestOptions {
  /** Set pthid for nested thread correlation. */
  parentThread?: string;
  /** AbortSignal for timeout/cancellation control. */
  signal?: AbortSignal;
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
  private readonly registry = new HandlerRegistry();
  private channel: PhoenixChannel | null = null;
  private connected = false;
  private isClosed = false;
  private agentDid: string;

  /** Correlation map for Request/Response pattern: threadId → resolve function */
  private readonly pending = new Map<
    string,
    (msg: InternalMessage) => void
  >();

  constructor(cfg: Config = {}) {
    super();
    this.cfg = resolveConfig(cfg);
    this.agentDid = this.cfg.agentDid;
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
    for (const [threadId] of this.pending) {
      this.pending.delete(threadId);
    }
  }

  /** Send a fire-and-forget message. */
  async send(msg: Partial<Message>): Promise<void> {
    if (!this.connected || !this.channel) {
      throw new NotConnectedError();
    }

    const internal = this.fillMessage(msg);
    this.sendMessage(internal);
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

      this.pending.set(internal.threadId, (resp: InternalMessage) => {
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
      });

      try {
        this.sendMessage(internal);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  private handleInboundMessage(payload: unknown): void {
    let msg: InternalMessage;
    try {
      msg = parseDIDComm(payload);
    } catch {
      return; // silently drop unparseable messages
    }

    // Check if this is a response to a pending Request (by thread ID)
    if (msg.threadId) {
      const resolve = this.pending.get(msg.threadId);
      if (resolve) {
        this.pending.delete(msg.threadId);
        resolve(msg);
        return;
      }
    }

    // Route to registered handler
    const entry = this.registry.lookup(msg.type);
    if (!entry) return; // no handler registered

    // Auto-ack before handler (unless manual ack)
    if (!entry.manualAck) {
      this.channel!.sendAck([msg.id]);
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
    try {
      const resp = await fn(msg);

      if (resp) {
        // Auto-fill response fields
        const internal = this.fillMessage(resp);
        if (!internal.to.length && msg.from) {
          internal.to = [msg.from];
        }
        if (!internal.threadId) {
          internal.threadId = msg.threadId || msg.id;
        }
        this.sendMessage(internal);
      }
    } catch (err) {
      this.sendProblemReport(msg, err as Error);
    }
  }

  private sendProblemReport(original: InternalMessage, err: Error): void {
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

  private sendMessage(msg: InternalMessage): void {
    if (!this.channel) throw new NotConnectedError();
    const data = marshalDIDComm(msg);
    this.channel.send("message", JSON.parse(data));
  }
}
