/**
 * W3C Verifiable Presentation types and option interfaces.
 */

import type { CredentialFormat } from "./credentials.js";
import type { RestRequestOptions } from "./rest.js";

/** Returned by verifyPresentation — the decoded presentation and JWT headers. */
export interface VerifiedPresentation {
  presentation: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/**
 * Options for signPresentation.
 *
 * Like signing a credential, this is compute on the node with nothing flowing
 * on the wire, so a slow one counts as silence against `timeoutMs`.
 */
export interface SignPresentationOptions extends RestRequestOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
  /** Output format (defaults to "compact_jwt"). */
  format?: CredentialFormat;
  /** Optional nonce / challenge for the presentation. */
  nonce?: string;
}

/** Options for verifyPresentation. */
export interface VerifyPresentationOptions extends RestRequestOptions {
  /** Override the verifier DID (defaults to client.did). */
  verifierDid?: string;
}
