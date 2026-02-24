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
 */
export class ProblemReportError extends Layr8Error {
  readonly code: string;
  readonly comment: string;

  constructor(code: string, comment: string) {
    super(`problem report [${code}]: ${comment}`);
    this.name = "ProblemReportError";
    this.code = code;
    this.comment = comment;
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
