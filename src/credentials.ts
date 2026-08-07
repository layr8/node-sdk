/**
 * W3C Verifiable Credential types and option interfaces.
 */

import type { RestRequestOptions } from "./rest.js";

/** CredentialFormat controls the signed credential output encoding. */
export type CredentialFormat = "compact_jwt" | "json" | "jwt" | "enveloped";

/** A W3C Verifiable Credential for signing. */
export interface Credential {
  "@context"?: string[];
  id?: string;
  type?: string[];
  issuer?: string;
  credentialSubject: Record<string, unknown>;
  validFrom?: string;
  validUntil?: string;
}

/** Returned by verifyCredential — the decoded credential and JWT headers. */
export interface VerifiedCredential {
  credential: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/** A credential stored in the node's credential store. */
export interface StoredCredential {
  id: string;
  holder_did: string;
  credential_jwt: string;
  issuer_did?: string;
  valid_until?: string;
}

// Every option type below extends `RestRequestOptions`, so `timeoutMs` is
// defined ONCE — with the explanation of what it is measured on — instead of
// being restated six times and drifting.

/**
 * Options for signCredential.
 *
 * Signing is the call most likely to want a longer `timeoutMs` than the 30s
 * default: the node produces no bytes while it works, so that time reads as
 * silence to the deadline.
 */
export interface SignCredentialOptions extends RestRequestOptions {
  /** Override the issuer DID (defaults to client.did). */
  issuerDid?: string;
  /** Output format (defaults to "compact_jwt"). */
  format?: CredentialFormat;
}

/** Options for verifyCredential. */
export interface VerifyCredentialOptions extends RestRequestOptions {
  /** Override the verifier DID (defaults to client.did). */
  verifierDid?: string;
}

/** Options for storeCredential. */
export interface StoreCredentialOptions extends RestRequestOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
  /** Optional issuer DID metadata. */
  issuerDid?: string;
  /** Optional expiration date. */
  validUntil?: Date;
}

/** Options for listCredentials. */
export interface ListCredentialsOptions extends RestRequestOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
}

/**
 * Options for getCredential.
 *
 * The call takes an ID and nothing else, so this exists only to carry
 * `timeoutMs` — named and exported anyway, because every other REST method on
 * the client has a named options type and an inline `{ timeoutMs?: number }`
 * would be the one a caller cannot import to build.
 */
export interface GetCredentialOptions extends RestRequestOptions {}
