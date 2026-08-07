/**
 * W3C Verifiable Presentation types and option interfaces.
 *
 * These back `signPresentation` / `verifyPresentation` (see `client.ts`),
 * which exist for proving credential possession to a VERIFIER — e.g. a REST
 * caller checking proof of a credential. They are NOT the path for attaching
 * a Verifiable Grant to an outbound DIDComm message. The cloud-node's
 * authorization extractor accepts only attachments whose `media_type` is
 * exactly `application/vc+jwt`; a presentation's `application/vp+jwt` is
 * dropped before the data is even read, and the resulting denial is
 * indistinguishable from attaching nothing.
 *
 * For authorization attachments, use `attachGrants` (default on — see
 * `wallet.ts` and the README's "Verifiable Grants" section) rather than
 * signing a presentation.
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
