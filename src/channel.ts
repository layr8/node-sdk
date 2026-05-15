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
  /**
   * Monotonic timestamp (Date.now()) of the most recently observed inbound
   * frame — any message, pong, or phx_reply. Used by the Phoenix-level
   * watchdog in startHeartbeat to detect "TCP healthy but Phoenix Channel
   * GenServer hung" failures: when the heartbeat tick observes no frames
   * for HEARTBEAT_MAX_SILENT_MS, it forces a close that the existing
   * reconnect path picks up.
   */
  private lastFrameAt = Date.now();
  /**
   * Timer that periodically emits a WS-level `{:ping, _}` frame. Independent
   * of the Phoenix heartbeat — covers the TCP / NAT / LB half-dead case
   * where the connection is unilaterally killed without a FIN.
   */
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Timer armed each time we emit a WS ping. Cleared on any inbound frame
   * (pong, message, phx_reply — anything proves liveness). If it fires we
   * force-close the WS so the existing reconnect path takes over.
   */
  private pongWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private assignedDIDVal = "";
  private readonly pendingRefs = new Map<string, {
    resolve: (reply: ServerReply) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Liveness detection constants. The Phoenix-level watchdog (HEARTBEAT_*)
  // covers application-layer hangs; the WS-level ping/pong (WS_PING_* /
  // PONG_WAIT_*) covers transport-layer hangs. Independent layers — both
  // are needed because cowboy auto-pongs at the WS layer even when the
  // Phoenix Channel GenServer has stopped processing.
  //
  // 75 000 ms = 2.5× heartbeat interval: tolerates one missed reply, trips
  // on two consecutive misses.
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_MAX_SILENT_MS = 75_000;
  private static readonly WS_PING_INTERVAL_MS = 25_000;
  private static readonly WS_PONG_WAIT_MS = 35_000;

  private replyProtocolEnabled = false;
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
        // Reset the watchdog clock so the first heartbeat tick after
        // (re)connect measures silence from "just now", not from before
        // the disconnect.
        this.lastFrameAt = Date.now();
        this.setupReadLoop();
        this.startHeartbeat();
        this.startWsPingLoop();

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
      reply_protocol: true,
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
          response?: { did?: string; reason?: string; capabilities?: string[] };
        };
        if (reply.status !== "ok") {
          const reason = reply.response?.reason ?? `join rejected: ${reply.status}`;
          reject(new ConnectionError(this.wsUrl, reason));
          return;
        }
        if (reply.response?.did) {
          this.assignedDIDVal = reply.response.did;
        }
        const caps = reply.response?.capabilities ?? [];
        this.replyProtocolEnabled = caps.includes("reply_protocol/1");
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

  /** Whether the server supports the reply protocol (capability negotiated at join). */
  replyProtocol(): boolean {
    return this.replyProtocolEnabled;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconnecting = false;

    this.stopLivenessTimers();

    // Reject all pending refs
    for (const [, pending] of this.pendingRefs) {
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
      // Any inbound frame proves the connection is alive end-to-end —
      // disarm both watchdogs before dispatch. Heartbeat ack, message
      // event, phx_reply, phx_error, all count.
      this.lastFrameAt = Date.now();
      this.disarmPongWait();
      try {
        const msg = unmarshalPhoenixMsg(data.toString());
        this.handleInbound(msg);
      } catch {
        // Phoenix wire format parse failure — not a DIDComm error.
        // Transport-level noise (e.g., truncated frames), matches Go SDK behavior.
      }
    });

    // WS-level pong arrival in response to our ping (or unsolicited).
    // Either way, the transport is alive — clear pong_wait. We also
    // bump lastFrameAt for the Phoenix-level watchdog, since a pong
    // round-trip proves cowboy + TCP are healthy.
    this.ws.on("pong", () => {
      this.lastFrameAt = Date.now();
      this.disarmPongWait();
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

      const silentMs = Date.now() - this.lastFrameAt;
      if (silentMs > PhoenixChannel.HEARTBEAT_MAX_SILENT_MS) {
        // Application-layer hang: cloud-node's Phoenix Channel GenServer
        // is no longer responding (we'd have seen heartbeat acks or
        // other frames by now). Terminate the socket and let the
        // existing reconnect path take over.
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
        return;
      }

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
    }, PhoenixChannel.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * WS-level ping every WS_PING_INTERVAL_MS. Cowboy (Phoenix's HTTP/WS
   * server) auto-pongs at the protocol layer — even if the application
   * Channel is hung. When the underlying TCP / NAT / LB has silently
   * dropped the connection, ping write may succeed locally but no pong
   * comes back; pongWaitTimer fires and we force-close.
   */
  private startWsPingLoop(): void {
    this.wsPingTimer = setInterval(() => {
      if (this.closed || !this.ws) return;
      try {
        this.ws.ping();
        this.armPongWait();
      } catch {
        // ping write failed — connection likely dead; let
        // ws.on("error") path handle it
      }
    }, PhoenixChannel.WS_PING_INTERVAL_MS);
  }

  private armPongWait(): void {
    if (this.pongWaitTimer) {
      clearTimeout(this.pongWaitTimer);
    }
    this.pongWaitTimer = setTimeout(() => {
      this.pongWaitTimer = null;
      if (this.closed || !this.ws) return;
      // No pong (or any frame) within WS_PONG_WAIT_MS of the last ping —
      // transport is dead. Terminate; reconnect path takes over.
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }, PhoenixChannel.WS_PONG_WAIT_MS);
  }

  private disarmPongWait(): void {
    if (this.pongWaitTimer) {
      clearTimeout(this.pongWaitTimer);
      this.pongWaitTimer = null;
    }
  }

  private stopLivenessTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    this.disarmPongWait();
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

    // Stop all liveness timers — dial() will re-arm them after the new
    // socket opens.
    this.stopLivenessTimers();

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
