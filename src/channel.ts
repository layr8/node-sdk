import WebSocket from "ws";
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private assignedDIDVal = "";

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    agentDid: string,
    callbacks: ChannelCallbacks,
  ) {
    this.topic = `plugins:${agentDid}`;
    this.callbacks = callbacks;
  }

  async connect(protocols: string[], signal?: AbortSignal): Promise<void> {
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
          await this.join(protocols, signal);
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

    const joinPayload = {
      payload_types: protocols,
      did_spec: {
        mode: "Create",
        storage: "ephemeral",
        type: "plugin",
        verificationMethods: [
          { purpose: "authentication" },
          { purpose: "assertionMethod" },
          { purpose: "keyAgreement" },
        ],
      },
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
          response?: { did?: string };
        };
        if (reply.status !== "ok") {
          reject(
            new ConnectionError(
              this.wsUrl,
              `join rejected: ${reply.status}`,
            ),
          );
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

  send(event: string, payload: unknown): void {
    this.writeMsg({
      joinRef: null,
      ref: this.nextRef(),
      topic: this.topic,
      event,
      payload,
    });
  }

  sendAck(ids: string[]): void {
    this.send("ack", { ids });
  }

  assignedDID(): string {
    return this.assignedDIDVal;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

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
        // silently drop unparseable messages
      }
    });

    this.ws.on("close", () => {
      if (!this.closed && this.callbacks.onDisconnect) {
        this.callbacks.onDisconnect(new Error("WebSocket closed"));
      }
    });

    this.ws.on("error", (err) => {
      if (!this.closed && this.callbacks.onDisconnect) {
        this.callbacks.onDisconnect(err as Error);
      }
    });
  }

  private handleInbound(msg: PhoenixMessage): void {
    switch (msg.event) {
      case "phx_reply":
        if (this.pendingJoinResolve && msg.ref === this.joinRef) {
          const resolve = this.pendingJoinResolve;
          this.pendingJoinResolve = null;
          resolve(msg.payload);
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
