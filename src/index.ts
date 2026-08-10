export { Layr8Client, DidHandle } from "./client.js";
export type {
  RequestOptions,
  SendOptions,
  JoinDidOptions,
  JoinDidHandler,
} from "./client.js";

// MCP (Model Context Protocol) over DIDComm
export { McpBinding, McpPeer, McpError, DEFAULT_MCP_BASE } from "./mcp.js";
export type { McpCallOptions } from "./mcp.js";

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
export { PASS } from "./handler.js";
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
// The per-call deadline every credential/presentation option type carries. The
// name says REST on purpose: `RequestOptions` above is the DIDComm one, and a
// caller reaching for a timeout should not have to guess which of two
// same-named types it landed on.
export type { RestRequestOptions } from "./rest.js";

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
  GetCredentialOptions,
} from "./credentials.js";

// W3C Verifiable Presentation types
export type {
  VerifiedPresentation,
  SignPresentationOptions,
  VerifyPresentationOptions,
} from "./presentations.js";

// Space watch — dual poll + signature-diff + notify for "does my MCP tool
// surface still look the same" (wallet + resource set). See
// contracts/sdk-space-watch.md for the cross-language behavioral contract.
export { SpaceWatcher, orderIndependentSignature, acceptsResourcePoll } from "./space-watch.js";
export type { SpaceWatcherOptions, SpaceWatchSignal } from "./space-watch.js";
