import WebSocket from "ws";
import { Backoff } from "./backoff.js";
import { ConnectionError, NotConnectedError } from "./errors.js";
import type { Channel } from "./channel.js";

/**
 * Phoenix Channel V2 wire format: [join_ref, ref, topic, event, payload]
 */
export interface PhoenixMessage {
  joinRef: string | null;
  ref: string | null;
  topic: string;
  event: string;
  payload: unknown;
}

export function marshalPhoenixMsg(msg: PhoenixMessage): string {
  return JSON.stringify([
    msg.joinRef,
    msg.ref,
    msg.topic,
    msg.event,
    msg.payload,
  ]);
}

export function unmarshalPhoenixMsg(data: string): PhoenixMessage {
  const arr = JSON.parse(data) as unknown[];
  if (!Array.isArray(arr) || arr.length !== 5) {
    throw new Error(
      `expected 5-element array, got ${
        Array.isArray(arr) ? arr.length : typeof arr
      }`,
    );
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
    const hostHeader = parsed.host;
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

/**
 * Hooks the owner (`Layr8Client` / the deprecated `PhoenixChannel` facade)
 * can install to observe Connection lifecycle. Per-Channel events fire on
 * the Channel's own callbacks; these here are Connection-level only.
 */
export interface ConnectionCallbacks {
  /** Fired once when the WS errors / closes unexpectedly (before reconnect). */
  onDisconnect?: (err: Error) => void;
  /** Fired once after the WS is re-dialed and ALL channels have rejoined. */
  onReconnect?: () => void;
}

/**
 * Connection — the WebSocket-level half of the Phoenix Channel transport.
 *
 * Owns:
 *   - one underlying WebSocket
 *   - the global ref counter (refs are unique per WS, shared across topics)
 *   - the pending-ref table (every tracked outbound frame waits here for its
 *     phx_reply, regardless of which Channel sent it)
 *   - the liveness timers (Phoenix-heartbeat watchdog + WS-level ping/pong)
 *   - the reconnect loop (with re-join of every Channel after a new dial)
 *   - the topic → Channel registry, populated by `openChannel`
 *
 * Does NOT know:
 *   - which DID each topic represents — that lives on `Channel`
 *   - protocol subscription payloads, `phx_join` semantics, assigned DIDs —
 *     those are framed and parsed by `Channel`
 *   - DIDComm message shape — the Connection moves opaque payload bytes only
 *
 * Single-DID usage and multi-DID usage share the same Connection: the only
 * difference is how many Channels live in the topic map.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private refCounter = 0;
  private closed = false;
  private reconnecting = false;

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

  /**
   * `ref` → pending phx_reply resolver. The resolver receives the **raw**
   * payload (whatever shape the server sent) — Channel.send normalises to
   * ServerReply for ordinary sends; Channel.join needs the raw shape to
   * extract `response.did`. Keeping the Connection payload-agnostic means
   * any future Channel-side shape (e.g. presence events) needs no
   * Connection change.
   */
  private readonly pendingRefs = new Map<string, {
    resolve: (rawPayload: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * topic → Channel registry. Populated by `openChannel`. The read loop
   * routes every inbound `message` / `phx_error` / `phx_close` frame to its
   * Channel by topic. `phx_reply` frames are correlated by ref via
   * `pendingRefs` (which works uniformly across all topics).
   */
  private readonly channels = new Map<string, Channel>();

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
  private static readonly SEND_REPLY_TIMEOUT_MS = 15_000;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly callbacks: ConnectionCallbacks = {},
  ) {}

  /**
   * Open the WebSocket. Does NOT join any Channel — call `openChannel` and
   * then `channel.join(...)` after this resolves.
   */
  async dial(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error("Connection is closed");
    }
    return this.dialImpl(signal);
  }

  /**
   * Register a new Channel for `did` on this Connection. The Channel is
   * inert until `channel.join(...)` is awaited.
   *
   * The same Connection may host any number of Channels — single-DID and
   * N-DID usage share this path.
   */
  registerChannel(channel: Channel): void {
    if (this.channels.has(channel.topic)) {
      throw new Error(`channel already registered for topic ${channel.topic}`);
    }
    this.channels.set(channel.topic, channel);
  }

  /** Unregister a Channel — `channel.leave()` already wrote `phx_leave`. */
  unregisterChannel(topic: string): void {
    this.channels.delete(topic);
  }

  /**
   * Move a Channel's Map key from `oldTopic` to `newTopic`. Used by
   * `Channel.joinImpl` for the auto-DID path: the Channel is constructed
   * with the placeholder topic `"plugins:"` (because the DID isn't known
   * yet), and once the server's join reply supplies the assigned DID, the
   * Channel re-registers under the real topic so inbound messages route.
   */
  rekeyChannel(oldTopic: string, newTopic: string): void {
    const channel = this.channels.get(oldTopic);
    if (!channel) return;
    if (oldTopic === newTopic) return;
    if (this.channels.has(newTopic)) {
      throw new Error(`channel already registered for topic ${newTopic}`);
    }
    this.channels.delete(oldTopic);
    this.channels.set(newTopic, channel);
  }

  /** Look up a Channel by its topic. Used by the read loop. */
  channelByTopic(topic: string): Channel | undefined {
    return this.channels.get(topic);
  }

  /** Iterate registered Channels — used by the reconnect path. */
  allChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** Allocate the next ref (globally unique within this WS). */
  nextRef(): string {
    this.refCounter++;
    return String(this.refCounter);
  }

  /**
   * Track a ref as pending and return a promise that resolves on the
   * matching `phx_reply`. The caller is responsible for writing the frame
   * that carries this `ref` (via `writeMsg`) AFTER this is called — the
   * tracking must be installed first so a fast reply isn't lost.
   *
   * The ref MUST come from `nextRef()`; using an arbitrary string risks
   * collision with the counter.
   */
  trackPendingRef(ref: string): Promise<unknown> {
    // No reconnecting/closed guard here on purpose: this method is also
    // called by Channel.rejoin from inside the reconnect loop (where
    // `reconnecting` is `true` and the WS has just been re-dialed). The
    // user-facing "block sends during reconnect" check lives on
    // Channel.send via `Connection.isConnected()`; this lower-level
    // primitive only registers the ref → resolver mapping.
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRefs.get(ref);
        if (pending) {
          this.pendingRefs.delete(ref);
          reject(new Error("server reply timeout"));
        }
      }, Connection.SEND_REPLY_TIMEOUT_MS);

      this.pendingRefs.set(ref, {
        resolve: (rawPayload) => {
          clearTimeout(timer);
          this.pendingRefs.delete(ref);
          resolve(rawPayload);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingRefs.delete(ref);
          reject(err);
        },
        timer,
      });
    });
  }

  /**
   * Direct WebSocket write. Throws `NotConnectedError` if the socket isn't
   * OPEN. Used by both tracked sends (after `trackPendingRef`) and
   * fire-and-forget sends.
   */
  writeMsg(msg: PhoenixMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new NotConnectedError();
    }
    this.ws.send(marshalPhoenixMsg(msg));
  }

  /**
   * Whether the underlying WS is currently OPEN. Channel.send / .join check
   * this before tracking to fail fast during reconnect windows.
   */
  isConnected(): boolean {
    return !this.closed && !this.reconnecting && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Close the Connection. Sends `phx_leave` for every registered Channel,
   * stops liveness timers, rejects all pending refs, closes the WebSocket.
   *
   * After `close()`, `dial()` will throw — construct a new Connection.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconnecting = false;

    this.stopLivenessTimers();

    // Send phx_leave for every Channel (best-effort) and let them tear
    // down their per-Channel state.
    for (const channel of this.channels.values()) {
      try {
        channel.onConnectionClose();
      } catch {
        // ignore
      }
    }
    this.channels.clear();

    // Reject all pending refs uniformly.
    for (const [, pending] of this.pendingRefs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection closed"));
    }
    this.pendingRefs.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private async dialImpl(signal?: AbortSignal): Promise<void> {
    this.refCounter = 0;

    // Close any previous WS left over from an earlier (failed) dial
    // attempt in the same reconnect loop. Without this, every backoff
    // iteration that gets past WS.open but fails to rejoin leaves a
    // dangling open socket on the server side — server.close() in tests
    // then waits indefinitely for clients to disconnect.
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    const parsed = new URL(this.wsUrl);
    parsed.searchParams.set("api_key", this.apiKey);
    parsed.searchParams.set("vsn", "2.0.0");

    const [url, hostHeader] = rewriteLocalhostUrl(parsed.toString());

    const wsOpts: WebSocket.ClientOptions = { handshakeTimeout: 10_000 };
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

      ws.on("open", () => {
        signal?.removeEventListener("abort", onAbort);
        this.ws = ws;
        // Reset the watchdog clock so the first heartbeat tick after
        // (re)connect measures silence from "just now", not from before
        // the disconnect.
        this.lastFrameAt = Date.now();
        this.setupReadLoop();
        this.startHeartbeat();
        this.startWsPingLoop();
        resolve();
      });
    });
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
        // Transport-level noise (e.g., truncated frames), matches Go SDK
        // behavior.
      }
    });

    this.ws.on("pong", () => {
      this.lastFrameAt = Date.now();
      this.disarmPongWait();
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        this.onUnexpectedDisconnect(new Error("WebSocket closed"));
      }
    });

    this.ws.on("error", (err) => {
      if (!this.closed) {
        this.onUnexpectedDisconnect(err as Error);
      }
    });
  }

  /**
   * Inbound frame dispatch.
   *
   *   phx_reply  → match by ref in pendingRefs (covers sends AND joins
   *                uniformly, since join requests also live in pendingRefs
   *                while waiting for their reply).
   *   message    → route to Channel by topic.
   *   phx_error  → route to Channel by topic.
   *   phx_close  → route to Channel by topic.
   */
  private handleInbound(msg: PhoenixMessage): void {
    switch (msg.event) {
      case "phx_reply":
        if (msg.ref) {
          const pending = this.pendingRefs.get(msg.ref);
          if (pending) {
            // Pass the raw payload through — the Channel-side resolver
            // (Channel.send for ordinary sends, Channel.joinImpl for
            // joins) is responsible for shape interpretation.
            pending.resolve(msg.payload);
          }
        }
        break;
      case "message": {
        const channel = this.channels.get(msg.topic);
        if (channel) channel.onMessage(msg.payload);
        break;
      }
      case "phx_error":
      case "phx_close": {
        const channel = this.channels.get(msg.topic);
        if (channel) channel.onChannelTeardown(new Error(`channel ${msg.event}`));
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || !this.ws) return;

      const silentMs = Date.now() - this.lastFrameAt;
      if (silentMs > Connection.HEARTBEAT_MAX_SILENT_MS) {
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
    }, Connection.HEARTBEAT_INTERVAL_MS);
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
    }, Connection.WS_PING_INTERVAL_MS);
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
    }, Connection.WS_PONG_WAIT_MS);
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

  private onUnexpectedDisconnect(err: Error): void {
    this.rejectPendingRefs();
    for (const channel of this.channels.values()) {
      try {
        channel.onUnexpectedDisconnect(err);
      } catch {
        // ignore listener exceptions on disconnect path
      }
    }
    this.callbacks.onDisconnect?.(err);
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.stopLivenessTimers();

    const bo = new Backoff(1000, 30000);

    while (!this.closed) {
      const delay = bo.next();
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.closed) return;

      try {
        await this.dialImpl();
        // WS is back up. Re-join every Channel that was registered before
        // the disconnect. Channels keep their join params (protocols /
        // didSpec) precisely so they can rejoin themselves here.
        //
        // Single-DID parity: when there is exactly one Channel, propagate
        // a rejoin failure to the outer retry loop — this matches the
        // pre-refactor PhoenixChannel behaviour where dial-and-join were
        // a single atomic step and any failure restarted the backoff.
        // Ember (single-DID) relies on this: a transient server hiccup
        // during reconnect must keep retrying, not leave the client in a
        // silently-broken "reconnected but Channel.send throws" state.
        //
        // Multi-DID isolation: with 2+ Channels, an individual rejoin
        // failure must NOT block the others — typically the gateway has
        // tens of Instance Channels and a single Instance's transient
        // failure should not stall the others' service. The failed
        // Channel stays registered in a not-joined state; its
        // `onDisconnect` already fired and any per-Channel `send` will
        // throw `NotConnectedError` until the caller retries.
        const registered = this.allChannels();
        if (registered.length === 1) {
          await registered[0]!.rejoin();
        } else {
          for (const channel of registered) {
            try {
              await channel.rejoin();
            } catch {
              // see comment above — isolated failure, do not cascade
            }
          }
        }
        this.reconnecting = false;
        this.callbacks.onReconnect?.();
        for (const channel of this.channels.values()) {
          try {
            channel.onReconnect();
          } catch {
            // ignore listener exceptions
          }
        }
        return;
      } catch {
        // dial failed, OR (single-DID) rejoin failed — retry the backoff loop
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
}
