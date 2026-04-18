export { Layr8Client } from "./client.js";
export type { RequestOptions, SendOptions } from "./client.js";
export type { Config, DidSpec, VerificationMethod } from "./config.js";
export { DEFAULT_DID_SPEC } from "./config.js";
export type {
  Attachment,
  Message,
  MessageContext,
  SenderCredential,
  InternalMessage,
} from "./message.js";
// Re-export the deprecated Credential alias from message.ts for backwards compat.
// The new W3C Credential from credentials.ts takes priority as the primary "Credential" export.
export type { Credential as SenderCredentialCompat } from "./message.js";
export {
  unmarshalBody,
  ack,
  createMessage,
} from "./message.js";
export type { HandlerFn, HandlerOptions } from "./handler.js";
export {
  Layr8Error,
  NotConnectedError,
  AlreadyConnectedError,
  ClientClosedError,
  ProblemReportError,
  ConnectionError,
  ServerRejectError,
  ErrorKind,
  SDKError,
  logErrors,
} from "./errors.js";
export type { ErrorHandler } from "./errors.js";
export type { ServerReply } from "./channel.js";

// REST client
export { RESTError } from "./rest.js";

// W3C Verifiable Credential types
export type {
  Credential,
  CredentialFormat,
  VerifiedCredential,
  StoredCredential,
  SignCredentialOptions,
  VerifyCredentialOptions,
  StoreCredentialOptions,
  ListCredentialsOptions,
} from "./credentials.js";

// W3C Verifiable Presentation types
export type {
  VerifiedPresentation,
  SignPresentationOptions,
  VerifyPresentationOptions,
} from "./presentations.js";
