import { v4 as uuidv4 } from "uuid";

/** Metadata from the cloud-node, present on inbound messages. */
export interface MessageContext {
  recipient: string;
  authorized: boolean;
  senderCredentials: Credential[];
}

/** A sender credential from the cloud-node. */
export interface Credential {
  id: string;
  name: string;
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
  };

  if (env.context) {
    const creds: Credential[] = (env.context.sender_credentials || []).map(
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
