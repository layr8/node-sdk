import { Layr8Error } from "./errors.js";

/** Verification method purpose for DID creation. */
export interface VerificationMethod {
  /** Key purpose: authentication, assertionMethod, keyAgreement, capabilityInvocation, capabilityDelegation. */
  purpose: string;
  /** Key type. Defaults based on purpose (e.g., Ed25519VerificationKey2020 for authentication). */
  type?: string;
  /** Curve for JsonWebKey2020: Ed25519, X25519, P-256, P-384, P-521, secp256k1. */
  curve?: string;
  /** Optional key ID. */
  id?: string;
}

/** DID specification for the cloud-node join handshake. */
export interface DidSpec {
  /** How to handle DID creation: Create (create if not found), Require (must exist), Update (create or update). */
  mode?: string;
  /** Where to store the DID: persistent (database) or ephemeral (memory only). */
  storage?: string;
  /** Optional label for the DID. */
  label?: string;
  /** Optional type metadata (e.g., "plugin", "service"). */
  type?: string;
  /** Cryptographic verification methods to create. */
  verificationMethods?: VerificationMethod[];
}

/** Default DID specification matching the original hardcoded behavior. */
export const DEFAULT_DID_SPEC: Required<DidSpec> = {
  mode: "Create",
  storage: "ephemeral",
  label: "",
  type: "plugin",
  verificationMethods: [
    { purpose: "authentication" },
    { purpose: "assertionMethod" },
    { purpose: "keyAgreement" },
  ],
};

/** Configuration for a Layr8 client. */
export interface Config {
  /** WebSocket URL of the Layr8 cloud-node. Fallback: LAYR8_NODE_URL env. */
  nodeUrl?: string;
  /** Authentication key for the cloud-node. Fallback: LAYR8_API_KEY env. */
  apiKey?: string;
  /** DID identity of this agent. If empty, an ephemeral DID is created on connect(). Fallback: LAYR8_AGENT_DID env. */
  agentDid?: string;
  /** DID specification for the cloud-node join handshake. Merged with defaults. */
  didSpec?: DidSpec;
}

/** Resolved configuration with required fields guaranteed present. */
export interface ResolvedConfig {
  nodeUrl: string;
  apiKey: string;
  agentDid: string;
  didSpec: Required<DidSpec>;
}

/** Fills empty fields from environment variables and validates required fields. */
export function resolveConfig(cfg: Config): ResolvedConfig {
  const nodeUrl = cfg.nodeUrl || process.env.LAYR8_NODE_URL || "";
  const apiKey = cfg.apiKey || process.env.LAYR8_API_KEY || "";
  const agentDid = cfg.agentDid || process.env.LAYR8_AGENT_DID || "";

  if (!nodeUrl) {
    throw new Layr8Error(
      "nodeUrl is required (set in Config or LAYR8_NODE_URL env)",
    );
  }

  // Normalize HTTP(S) URLs to WebSocket scheme.
  // In production, the /plugin_socket endpoint serves WebSocket over HTTPS.
  let normalizedUrl = nodeUrl;
  if (normalizedUrl.startsWith("https://")) {
    normalizedUrl = "wss://" + normalizedUrl.slice("https://".length);
  } else if (normalizedUrl.startsWith("http://")) {
    normalizedUrl = "ws://" + normalizedUrl.slice("http://".length);
  }

  if (!apiKey) {
    throw new Layr8Error(
      "apiKey is required (set in Config or LAYR8_API_KEY env)",
    );
  }

  const didSpec: Required<DidSpec> = {
    ...DEFAULT_DID_SPEC,
    ...cfg.didSpec,
    verificationMethods:
      cfg.didSpec?.verificationMethods ?? DEFAULT_DID_SPEC.verificationMethods,
  };

  return { nodeUrl: normalizedUrl, apiKey, agentDid, didSpec };
}
