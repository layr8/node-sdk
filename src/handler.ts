import type { Message } from "./message.js";

/** Handler function signature. Return a response Message, or null for fire-and-forget. */
export type HandlerFn = (msg: Message) => Promise<Message | null>;

/** Options for handler registration. */
export interface HandlerOptions {
  manualAck?: boolean;
}

export interface HandlerEntry {
  fn: HandlerFn;
  manualAck: boolean;
}

/** Thread-safe handler registry mapping message types to handlers. */
export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerEntry>();

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

  lookup(msgType: string): HandlerEntry | undefined {
    return this.handlers.get(msgType);
  }

  /**
   * Returns the unique protocol base URIs derived from registered handler message types.
   * e.g. "https://layr8.io/protocols/echo/1.0/request" → "https://layr8.io/protocols/echo/1.0"
   */
  protocols(): string[] {
    const seen = new Set<string>();
    for (const msgType of this.handlers.keys()) {
      seen.add(deriveProtocol(msgType));
    }
    return [...seen];
  }
}

/** Extract the protocol base URI by removing the last path segment. */
function deriveProtocol(msgType: string): string {
  const idx = msgType.lastIndexOf("/");
  return idx === -1 ? msgType : msgType.slice(0, idx);
}
