import { v4 as uuidv4 } from "uuid";

/** Metadata from the cloud-node, present on inbound messages. */
export interface MessageContext {
  recipient: string;
  authorized: boolean;
  senderCredentials: SenderCredential[];
}

/** A sender credential from the cloud-node. */
export interface SenderCredential {
  id: string;
  name: string;
}

/**
 * @deprecated Use {@link SenderCredential} instead. This alias exists for backwards compatibility.
 */
export type Credential = SenderCredential;

/** A DIDComm v2 attachment. */
export interface Attachment {
  id?: string;
  description?: string;
  filename?: string;
  media_type?: string;
  format?: string;
  /**
   * A hint about when the attached content was last modified.
   *
   * Two forms arrive, and the type has to admit both.
   *
   * DIDComm v2 defines the field, in full, as "OPTIONAL. A hint about when
   * the content in this attachment was last modified" — and states no type
   * for it. The same document pins `created_time` and `expires_time` to "UTC
   * Epoch Seconds (seconds since 1970-01-01T00:00:00Z) as an integer", so the
   * silence here is visible rather than accidental. Both DIF reference
   * implementations (didcomm-rust, didcomm-python) carry an integer, and that
   * is where senders are heading; a Layr8 cloud-node has historically sent an
   * ISO-8601 string instead, and messages carrying one are already in flight.
   *
   * This type was `string` alone, which was a claim about the wire that the
   * wire did not owe us: a sender emitting an integer would have handed
   * callers a `number` typed as a `string`, and string operations on it fail
   * at runtime with nothing at compile time to warn them. Widening it here
   * has to ship and be released BEFORE any sender switches its default.
   *
   * The value is passed through exactly as received — this SDK does not
   * normalize it — so `undefined` means the field was absent and anything
   * else is what the peer actually sent. Narrow with `typeof` before use.
   */
  lastmod_time?: number | string;
  byte_count?: number;
  data: {
    jws?: unknown;
    hash?: string;
    links?: string[];
    base64?: string;
    json?: unknown;
  };
}

/**
 * W3C trace context carried in the DIDComm plaintext header `trace_context`.
 *
 * The member names are the W3C header names, so the object is a ready-made
 * text-map carrier for an OpenTelemetry propagator. `traceparent` is a W3C
 * Trace Context Level 1 value; `tracestate` is optional. This SDK carries the
 * value; it does not validate the `traceparent` format (the node does).
 */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

/**
 * Reads a `trace_context` header value.
 *
 * Returns `undefined` for anything that is not an object with a string
 * `traceparent`. That is never an error: a malformed header must not stop a
 * message from being parsed. Only the two defined members are kept; any other
 * member is dropped and never forwarded.
 */
export function readTraceContext(value: unknown): TraceContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { traceparent, tracestate } = value as Record<string, unknown>;
  if (typeof traceparent !== "string") return undefined;
  return typeof tracestate === "string" ? { traceparent, tracestate } : { traceparent };
}

/** A DIDComm v2 message. */
export interface Message {
  id: string;
  type: string;
  from: string;
  to: string[];
  threadId: string;
  parentThreadId: string;
  body: unknown;
  attachments?: Attachment[];
  /**
   * The `trace_context` header. Absent when the message carried none, or
   * carried one this SDK could not read. A handler's reply and the problem
   * report for a failed handler copy the request's value when the reply does
   * not set its own.
   */
  traceContext?: TraceContext;
  context?: MessageContext;
}

/**
 * Internal message representation with raw body bytes and ack function.
 * Used within the SDK; handlers receive Message but internal routing uses this.
 */
export interface InternalMessage extends Message {
  /** Raw JSON body for lazy deserialization. */
  bodyRaw?: unknown;
  /** Manual ack function, set by client when manualAck is enabled. */
  ackFn?: (id: string) => void;
}

/** Decode the body from an inbound message into a typed object. */
export function unmarshalBody<T>(msg: InternalMessage): T {
  if (msg.bodyRaw !== undefined) {
    return msg.bodyRaw as T;
  }
  return msg.body as T;
}

/** Manually acknowledge a message (only meaningful with manualAck). */
export function ack(msg: InternalMessage): void {
  if (msg.ackFn) {
    msg.ackFn(msg.id);
  }
}

/** Create a Message with default empty fields, merging any partial input. */
export function createMessage(partial?: Partial<Message>): InternalMessage {
  return {
    id: "",
    type: "",
    from: "",
    to: [],
    threadId: "",
    parentThreadId: "",
    body: null,
    ...partial,
  };
}

/** Generate a new unique message ID. */
export function generateId(): string {
  return uuidv4();
}

/** DIDComm wire format for outbound messages. */
interface DIDCommEnvelope {
  id: string;
  type: string;
  from: string;
  to: string[];
  thid?: string;
  pthid?: string;
  body: unknown;
  attachments?: Attachment[];
  trace_context?: TraceContext;
}

/** Serialize a Message into DIDComm JSON wire format. */
export function marshalDIDComm(msg: InternalMessage): string {
  const env: DIDCommEnvelope = {
    id: msg.id,
    type: msg.type,
    from: msg.from,
    to: msg.to,
    body: msg.body ?? msg.bodyRaw ?? {},
  };
  if (msg.threadId) env.thid = msg.threadId;
  if (msg.parentThreadId) env.pthid = msg.parentThreadId;
  if (msg.attachments && msg.attachments.length > 0) env.attachments = msg.attachments;
  const traceContext = readTraceContext(msg.traceContext);
  if (traceContext) env.trace_context = traceContext;
  return JSON.stringify(env);
}

/** Inbound envelope from the cloud-node (context + plaintext). */
interface InboundEnvelope {
  context?: {
    recipient: string;
    authorized: boolean;
    sender_credentials?: Array<{
      credential_subject: { id: string; name: string };
    }>;
  };
  plaintext: {
    id: string;
    type: string;
    from: string;
    to?: string[];
    thid?: string;
    pthid?: string;
    body?: unknown;
    attachments?: Attachment[];
    trace_context?: unknown;
  };
}

/** Parse an inbound cloud-node message (context + plaintext) into an InternalMessage. */
export function parseDIDComm(data: unknown): InternalMessage {
  const env = data as InboundEnvelope;
  const pt = env.plaintext;

  const msg: InternalMessage = {
    id: pt.id || "",
    type: pt.type || "",
    from: pt.from || "",
    to: pt.to || [],
    threadId: pt.thid || "",
    parentThreadId: pt.pthid || "",
    body: pt.body ?? null,
    bodyRaw: pt.body,
    ...(pt.attachments ? { attachments: pt.attachments } : {}),
  };
  const traceContext = readTraceContext(pt.trace_context);
  if (traceContext) msg.traceContext = traceContext;

  if (env.context) {
    const creds: SenderCredential[] = (env.context.sender_credentials || []).map(
      (c) => ({
        id: c.credential_subject.id,
        name: c.credential_subject.name,
      }),
    );
    msg.context = {
      recipient: env.context.recipient,
      authorized: env.context.authorized,
      senderCredentials: creds,
    };
  }

  return msg;
}
