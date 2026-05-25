import type { Message } from "./message.js";

/** Sentinel value returned by handlers to signal "I don't handle this message". */
export const PASS: unique symbol = Symbol("PASS");

/**
 * A partial message returned from a handler. Only `type` is required;
 * the client fills in routing fields (id, from, to, threadId) automatically.
 */
export type ResponseMessage = Pick<Message, "type"> & Partial<Message>;

/** Handler function signature. Return a ResponseMessage, null, or PASS. */
export type HandlerFn = (msg: Message) => ResponseMessage | null | typeof PASS | Promise<ResponseMessage | null | typeof PASS>;

/** Options for handler registration. */
export interface HandlerOptions {
  manualAck?: boolean;
}

export interface HandlerEntry {
  fn: HandlerFn;
  manualAck: boolean;
}

/** Handler registry mapping message types to handlers, with optional catch-all. */
export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerEntry>();
  private catchAll: HandlerEntry | undefined;

  register(
    msgType: string,
    fn: HandlerFn,
    opts?: HandlerOptions,
  ): void {
    if (this.handlers.has(msgType)) {
      throw new Error(
        `handler already registered for message type "${msgType}"`,
      );
    }
    this.handlers.set(msgType, {
      fn,
      manualAck: opts?.manualAck ?? false,
    });
  }

  registerCatchAll(fn: HandlerFn, opts?: HandlerOptions): void {
    if (this.catchAll) {
      throw new Error("catch-all handler already registered");
    }
    this.catchAll = {
      fn,
      manualAck: opts?.manualAck ?? false,
    };
  }

  hasCatchAll(): boolean {
    return this.catchAll !== undefined;
  }

  lookup(msgType: string): HandlerEntry | undefined {
    return this.handlers.get(msgType) ?? this.catchAll;
  }

  /**
   * Returns the unique protocol base URIs derived from registered handler message types.
   * Appends "*" if a catch-all handler is registered.
   */
  protocols(): string[] {
    const seen = new Set<string>();
    for (const msgType of this.handlers.keys()) {
      seen.add(deriveProtocol(msgType));
    }
    if (this.catchAll) {
      seen.add("*");
    }
    return [...seen];
  }
}

/** Extract the protocol base URI by removing the last path segment. */
function deriveProtocol(msgType: string): string {
  const idx = msgType.lastIndexOf("/");
  return idx === -1 ? msgType : msgType.slice(0, idx);
}