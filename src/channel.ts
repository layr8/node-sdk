import WebSocket from "ws";
import { Backoff } from "./backoff.js";
import type { DidSpec } from "./config.js";
import { DEFAULT_DID_SPEC } from "./config.js";
import { ConnectionError, NotConnectedError } from "./errors.js";

/**
 * Phoenix Channel V2 wire format: [join_ref, ref, topic, event, payload]
 */
interface PhoenixMessage {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
}

function marshalPhoenixMsg(msg: PhoenixMessage): string {
  return JSON.stringify([
    msg.joinRef,
    msg.ref,
    msg.topic,
    msg.event,
    msg.payload,
  ]);
}

function unmarshalPhoenixMsg(data: string): PhoenixMessage {
  const arr = JSON.parse(data) as unknown[];
  if (!Array.isArray(arr) || arr.length !== 5) {
    throw new Error(`expected 5-element array, got ${Array.isArray(arr) ? arr.length : typeof arr}`);
  }
  return {
    joinRef: (arr[0] as string) ?? null,
    ref: (arr[1] as string) ?? null,
    topic: arr[2] as string,
    event: arr[3] as string,
    payload: arr[4],
  };
}

/** Returns true if host is "localhost" or a subdomain of it (RFC 6761). */
function isLocalhost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Rewrite a WebSocket URL so that *.localhost hostnames resolve to 127.0.0.1.
 * Returns [rewrittenUrl, hostHeader] — hostHeader is set when rewriting occurred.
 */
function rewriteLocalhostUrl(wsUrl: string): [string, string | undefined] {
  const parsed = new URL(wsUrl);
  if (isLocalhost(parsed.hostname)) {
    const hostHeader = parsed.host; // includes port if present
    parsed.hostname = "127.0.0.1";
    return [parsed.toString(), hostHeader];
  }
  return [wsUrl, undefined];
}

/** Server reply received for a tracked message ref. */
export interface ServerReply {
  status: string;
  reason: string;
}

export interface ChannelCallbacks {
  onMessage: (payload: unknown) => void;
  onDisconnect?: (err: Error) => void;
  onReconnect?: () => void;
}

/**
 * Phoenix Channel transport over WebSocket.
 * Implements the same protocol as the Go SDK's phoenixChannel.
 */
export class PhoenixChannel {
  private ws: WebSocket | null = null;
  private refCounter = 0;
  private joinRef = "";
  private readonly topic: string;
  private callbacks: ChannelCallbacks;
  private pendingJoinResolve: ((payload: unknown) => void) | null = null;
  private closed = false;
  private reconnecting = false;
  private protocols: string[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private assignedDIDVal = "";
  private readonly pendingRefs = new Map<string, {
    resolve: (reply: ServerReply) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly didSpec: Required<DidSpec>;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    agentDid: string,
    callbacks: ChannelCallbacks,
    didSpec?: DidSpec,
  ) {
    this.topic = `plugins:${agentDid}`;
    this.callbacks = callbacks;
    this.didSpec = { ...DEFAULT_DID_SPEC, ...didSpec, verificationMethods: didSpec?.verificationMethods ?? DEFAULT_DID_SPEC.verificationMethods };
  }

  async connect(protocols: string[], signal?: AbortSignal): Promise<void> {
    this.protocols = protocols;
    return this.dial(signal);
  }

  private async dial(signal?: AbortSignal): Promise<void> {
    this.refCounter = 0;

    const parsed = new URL(this.wsUrl);
    parsed.searchParams.set("api_key", this.apiKey);
    parsed.searchParams.set("vsn", "2.0.0");

    const [url, hostHeader] = rewriteLocalhostUrl(parsed.toString());

    const wsOpts: WebSocket.ClientOptions = {
      handshakeTimeout: 10_000,
    };
    if (hostHeader) {
      wsOpts.headers = { Host: hostHeader };
    }

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }

      const ws = new WebSocket(url, wsOpts);

      const onAbort = () => {
        ws.close();
        reject(signal!.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new ConnectionError(this.wsUrl, (err as Error).message));
      });

      ws.on("open", async () => {
        signal?.removeEventListener("abort", onAbort);
        this.ws = ws;
        this.setupReadLoop();
        this.startHeartbeat();

        try {
          await this.join(this.protocols, signal);
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      });
    });
  }

  private async join(
    protocols: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = this.nextRef();
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
      payload_types: protocols,
      did_spec: didSpecPayload,
    };

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }

      const onAbort = () => {
        this.pendingJoinResolve = null;
        reject(signal!.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingJoinResolve = (payload: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        const reply = payload as {
          status: string;
          response?: { did?: string; reason?: string };
        };
        if (reply.status !== "ok") {
          const reason = reply.response?.reason ?? `join rejected: ${reply.status}`;
          reject(new ConnectionError(this.wsUrl, reason));
          return;
        }
        if (reply.response?.did) {
          this.assignedDIDVal = reply.response.did;
        }
        resolve();
      };

      this.writeMsg({
        joinRef: ref,
        ref,
        topic: this.topic,
        event: "phx_join",
        payload: joinPayload,
      });
    });
  }

  send(event: string, payload: unknown): Promise<ServerReply> {
    if (this.reconnecting) {
      return Promise.reject(new NotConnectedError());
    }
    const ref = this.nextRef();

    return new Promise<ServerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRefs.get(ref);
        if (pending) {
          this.pendingRefs.delete(ref);
          reject(new Error("server reply timeout"));
        }
      }, 15_000); // 15 second timeout for server reply

      this.pendingRefs.set(ref, {
        resolve: (reply) => {
          clearTimeout(timer);
          this.pendingRefs.delete(ref);
          resolve(reply);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingRefs.delete(ref);
          reject(err);
        },
        timer,
      });

      try {
        this.writeMsg({
          joinRef: null,
          ref,
          topic: this.topic,
          event,
          payload,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRefs.delete(ref);
        reject(err);
      }
    });
  }

  sendFireAndForget(event: string, payload: unknown): void {
    if (this.reconnecting) {
      throw new NotConnectedError();
    }
    this.writeMsg({
      joinRef: null,
      ref: this.nextRef(),
      topic: this.topic,
      event,
      payload,
    });
  }

  sendAck(ids: string[]): void {
    this.sendFireAndForget("ack", { ids });
  }

  assignedDID(): string {
    return this.assignedDIDVal;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconnecting = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Reject all pending refs
    for (const [ref, pending] of this.pendingRefs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("channel closed"));
    }
    this.pendingRefs.clear();

    if (this.ws) {
      // Send phx_leave before closing
      try {
        this.writeMsg({
          joinRef: null,
          ref: this.nextRef(),
          topic: this.topic,
          event: "phx_leave",
          payload: {},
        });
      } catch {
        // ignore write errors during close
      }
      this.ws.close();
      this.ws = null;
    }
  }

  private setupReadLoop(): void {
    if (!this.ws) return;

    this.ws.on("message", (data) => {
      try {
        const msg = unmarshalPhoenixMsg(data.toString());
        this.handleInbound(msg);
      } catch {
        // Phoenix wire format parse failure — not a DIDComm error.
        // Transport-level noise (e.g., truncated frames), matches Go SDK behavior.
      }
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        this.rejectPendingRefs();
        if (this.callbacks.onDisconnect) {
          this.callbacks.onDisconnect(new Error("WebSocket closed"));
        }
        this.reconnectLoop();
      }
    });

    this.ws.on("error", (err) => {
      if (!this.closed) {
        this.rejectPendingRefs();
        if (this.callbacks.onDisconnect) {
          this.callbacks.onDisconnect(err as Error);
        }
        this.reconnectLoop();
      }
    });
  }

  private handleInbound(msg: PhoenixMessage): void {
    switch (msg.event) {
      case "phx_reply":
        // Join reply
        if (this.pendingJoinResolve && msg.ref === this.joinRef) {
          const resolve = this.pendingJoinResolve;
          this.pendingJoinResolve = null;
          resolve(msg.payload);
          return;
        }

        // Message send reply (ref tracking)
        if (msg.ref) {
          const pending = this.pendingRefs.get(msg.ref);
          if (pending) {
            const reply = msg.payload as { status?: string; response?: { reason?: string } };
            pending.resolve({
              status: reply?.status ?? "",
              reason: reply?.response?.reason ?? "",
            });
          }
        }
        break;
      case "message":
        this.callbacks.onMessage(msg.payload);
        break;
      case "phx_error":
      case "phx_close":
        if (this.callbacks.onDisconnect) {
          this.callbacks.onDisconnect(new Error(`channel ${msg.event}`));
        }
        break;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || !this.ws) return;
      try {
        this.writeMsg({
          joinRef: null,
          ref: this.nextRef(),
          topic: "phoenix",
          event: "heartbeat",
          payload: {},
        });
      } catch {
        // heartbeat write failed — connection likely dead
      }
    }, 30_000);
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    // Close existing ws
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const bo = new Backoff(1000, 30000);

    while (!this.closed) {
      const delay = bo.next();
      await new Promise(resolve => setTimeout(resolve, delay));
      if (this.closed) return;

      try {
        await this.dial();
        this.reconnecting = false;
        if (this.callbacks.onReconnect) {
          this.callbacks.onReconnect();
        }
        return;
      } catch {
        // will retry
      }
    }
  }

  private rejectPendingRefs(): void {
    for (const [, pending] of this.pendingRefs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("disconnected"));
    }
    this.pendingRefs.clear();
  }

  private nextRef(): string {
    this.refCounter++;
    return String(this.refCounter);
  }

  private writeMsg(msg: PhoenixMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new NotConnectedError();
    }
    this.ws.send(marshalPhoenixMsg(msg));
  }
}
