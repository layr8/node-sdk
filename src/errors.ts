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

/**
 * Query-parameter names whose value is a credential. Shared by
 * {@link redactUrl} and {@link redactUrlsInText} so the two cannot drift.
 */
const SENSITIVE_PARAM = /^(api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password)$/i;

/**
 * Strips credentials from a URL's query string, keeping everything a reader
 * needs to diagnose a connection failure (scheme, host, path, other params).
 *
 * The cloud-node URL carries the agent's API key as `?api_key=…`, so an
 * unredacted URL in an error message is a credential that travels wherever the
 * error travels — a log file, a crash report, a session transcript. That is not
 * hypothetical: a key reached a broker log this way, and from there a shared
 * transcript.
 *
 * Anything unparseable is reported as "<unparseable url>" rather than passed
 * through, because a URL this cannot parse is exactly the case where it cannot
 * promise the key is gone.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let touched = false;
    for (const name of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) {
        u.searchParams.set(name, "REDACTED");
        touched = true;
      }
    }
    if (u.password) {
      u.password = "REDACTED";
      touched = true;
    }
    // Only re-serialize when something changed, so an untouched URL is returned
    // byte-for-byte rather than normalized out from under the reader.
    return touched ? u.toString() : url;
  } catch {
    return "<unparseable url>";
  }
}

// A URL embedded in prose: scheme, `://`, then everything up to whitespace or a
// character that commonly delimits a quoted URL. Trailing sentence punctuation
// is peeled off afterwards, because `…?api_key=x.` must not redact `x.` as the
// value and then glue the full stop back on as part of the URL.
const EMBEDDED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
// A credential pair outside any URL this could recognise — a bare query string,
// or a URL whose scheme was cut off. Belt and braces behind EMBEDDED_URL.
const BARE_PAIR =
  /(^|[?&\s'"`(;,])(api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password)=([^&\s'"`#)\],;]+)/gi;

/**
 * Redacts credentials from every URL found inside free text — an error message
 * from the WebSocket runtime, say, which is not ours to shape.
 *
 * This exists because the reason a runtime gives for a failed dial can quote
 * the URL it dialed, key and all. Bun's WebSocket does exactly that:
 * `WebSocket connection to 'wss://…?api_key=…&vsn=2.0.0' failed: Failed to
 * connect`. Redacting only the URL we pass in misses it, because the URL we
 * pass in never carried the key — the one the runtime quotes does.
 *
 * Each URL is redacted with {@link redactUrl}'s rule; then any credential pair
 * left outside a recognisable URL is redacted too.
 */
export function redactUrlsInText(text: string): string {
  const urlsDone = text.replace(EMBEDDED_URL, (match) => {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
    const url = tail ? match.slice(0, -tail.length) : match;
    return redactUrl(url) + tail;
  });
  return urlsDone.replace(BARE_PAIR, (_m, lead: string, name: string, value: string) => {
    // As above: a full stop after the value ends the sentence, not the key.
    const tail = TRAILING_PUNCTUATION.exec(value)?.[0] ?? "";
    return `${lead}${name}=REDACTED${tail}`;
  });
}

/** Represents a failure to connect to the cloud-node. */
export class ConnectionError extends Layr8Error {
  /** The URL that failed, with any credentials in it redacted. */
  readonly url: string;
  /**
   * Why it failed, with any credentials in URLs it quotes redacted. Often the
   * runtime's own message, which may quote the full dialed URL.
   */
  readonly reason: string;

  constructor(url: string, reason: string) {
    // Redact once, here, and store the redacted forms: callers log `err.url`
    // and `err.reason` as readily as `err.message`, so redacting only the
    // message would leak through the properties. The reason needs it as much
    // as the url does — it is where the key actually appeared (see
    // redactUrlsInText).
    const safeUrl = redactUrl(url);
    const safeReason = redactUrlsInText(reason);
    super(`connection error [${safeUrl}]: ${safeReason}`);
    this.name = "ConnectionError";
    this.url = safeUrl;
    this.reason = safeReason;
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
  /** A background mediation step (enrol / declare / collect / live) failed. */
  Mediation,
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
