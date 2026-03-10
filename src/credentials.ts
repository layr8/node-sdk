/**
 * W3C Verifiable Credential types and option interfaces.
 */

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

/** Options for signCredential. */
export interface SignCredentialOptions {
  /** Override the issuer DID (defaults to client.did). */
  issuerDid?: string;
  /** Output format (defaults to "compact_jwt"). */
  format?: CredentialFormat;
}

/** Options for verifyCredential. */
export interface VerifyCredentialOptions {
  /** Override the verifier DID (defaults to client.did). */
  verifierDid?: string;
}

/** Options for storeCredential. */
export interface StoreCredentialOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
  /** Optional issuer DID metadata. */
  issuerDid?: string;
  /** Optional expiration date. */
  validUntil?: Date;
}

/** Options for listCredentials. */
export interface ListCredentialsOptions {
  /** Override the holder DID (defaults to client.did). */
  holderDid?: string;
}
