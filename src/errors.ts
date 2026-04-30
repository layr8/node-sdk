/** Base class for all Layr8 SDK errors. */
export class Layr8Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Layr8Error";
  }
}

/** Thrown when send/request is called before connect(). */
export class NotConnectedError extends Layr8Error {
  constructor() {
    super("client is not connected");
    this.name = "NotConnectedError";
  }
}

/** Thrown when handle() is called after connect(). */
export class AlreadyConnectedError extends Layr8Error {
  constructor() {
    super("client is already connected");
    this.name = "AlreadyConnectedError";
  }
}

/** Thrown when connect() is called after close(). */
export class ClientClosedError extends Layr8Error {
  constructor() {
    super("client is closed");
    this.name = "ClientClosedError";
  }
}

/**
 * Represents a DIDComm problem report received from a remote agent.
 * @see https://identity.foundation/didcomm-messaging/spec/#problem-reports
 *
 * Beyond the standard `code` + `comment`, holds the full report-problem
 * `body` (typed as unknown — caller knows their protocol's report shape)
 * and the raw `attachments` so a caller can inspect protocol-specific
 * fields (e.g. PDP `decision_id`, `reason`, `required_scope`,
 * `original_message`) without reaching into the underlying message.
 */
export class ProblemReportError extends Layr8Error {
  readonly code: string;
  readonly comment: string;
  readonly body: Record<string, unknown>;
  readonly attachments: unknown[];

  constructor(
    code: string,
    comment: string,
    body: Record<string, unknown> = {},
    attachments: unknown[] = [],
  ) {
    super(`problem report [${code}]: ${comment}`);
    this.name = "ProblemReportError";
    this.code = code;
    this.comment = comment;
    this.body = body;
    this.attachments = attachments;
  }
}

/** Represents a failure to connect to the cloud-node. */
export class ConnectionError extends Layr8Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`connection error [${url}]: ${reason}`);
    this.name = "ConnectionError";
    this.url = url;
    this.reason = reason;
  }
}

/** Thrown when the server rejects a message (e.g., authorization failure). */
export class ServerRejectError extends Layr8Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`server rejected message: ${reason}`);
    this.name = "ServerRejectError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Poka-yoke structured error types
// ---------------------------------------------------------------------------

/**
 * Classifies the kind of SDK error that occurred.
 * Mirrors the error kinds defined in the Go SDK for cross-language consistency.
 */
export enum ErrorKind {
  /** Inbound message could not be parsed as DIDComm. */
  ParseFailure,
  /** No handler registered for the message type. */
  NoHandler,
  /** A handler threw an exception. */
  HandlerException,
  /** The server rejected a message (e.g., authz failure). */
  ServerReject,
  /** Failed to write to the WebSocket connection. */
  TransportWrite,
}

/**
 * Structured error report for poka-yoke diagnostics.
 *
 * This is NOT a throwable Error — it is a plain object that carries
 * machine-readable context about what went wrong, so that ErrorHandler
 * callbacks can log, meter, or alert on SDK failures.
 */
export class SDKError {
  readonly kind: ErrorKind;
  readonly messageId: string;
  readonly type: string;
  readonly from: string;
  readonly cause: Error | null;
  readonly raw: unknown;
  readonly timestamp: Date;

  constructor(
    kind: ErrorKind,
    opts: {
      messageId?: string;
      type?: string;
      from?: string;
      cause?: Error;
      raw?: unknown;
    } = {},
  ) {
    this.kind = kind;
    this.messageId = opts.messageId ?? "";
    this.type = opts.type ?? "";
    this.from = opts.from ?? "";
    this.cause = opts.cause ?? null;
    this.raw = opts.raw ?? undefined;
    this.timestamp = new Date();
  }
}

/** Callback signature for handling structured SDK errors. */
export type ErrorHandler = (error: SDKError) => void;

/**
 * Returns an {@link ErrorHandler} that logs every error to `console.error`
 * with structured metadata.
 */
export function logErrors(): ErrorHandler {
  return (err: SDKError) => {
    console.error(
      `layr8 SDK error [${ErrorKind[err.kind]}]: ${err.cause?.message ?? "unknown"}`,
      {
        kind: ErrorKind[err.kind],
        messageId: err.messageId,
        type: err.type,
        from: err.from,
      },
    );
  };
}
