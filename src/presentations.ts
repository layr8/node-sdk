/**
 * W3C Verifiable Presentation types and option interfaces.
 */

import type { CredentialFormat } from "./credentials.js";

/** Returned by verifyPresentation — the decoded presentation and JWT headers. */
export interface VerifiedPresentation {
  presentation: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/** Options for signPresentation. */
export interface SignPresentationOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
  /** Output format (defaults to "compact_jwt"). */
  format?: CredentialFormat;
  /** Optional nonce / challenge for the presentation. */
  nonce?: string;
}

/** Options for verifyPresentation. */
export interface VerifyPresentationOptions {
  /** Override the verifier DID (defaults to client.did). */
  verifierDid?: string;
}
