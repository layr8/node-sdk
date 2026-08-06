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
  /** Optional controller DID for the created DID document. Defaults to the node DID. */
  controller?: string;
}

/** Default DID specification matching the original hardcoded behavior. */
export const DEFAULT_DID_SPEC: Required<DidSpec> = {
  mode: "Create",
  storage: "ephemeral",
  label: "",
  type: "plugin",
  controller: "",
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
  /** DID identity of this agent — the address other agents use to message it. Required: the cloud-node rejects a connection without a DID. Fallback: LAYR8_AGENT_DID env. */
  agentDid?: string;
  /** DID specification for the cloud-node join handshake. Merged with defaults. */
  didSpec?: DidSpec;
  /**
   * Attach the Verifiable Grants covering each outbound message. Default `true`.
   * Fallback: LAYR8_ATTACH_GRANTS env (`"false"`/`"0"` turns it off).
   *
   * The node requires a grant for anything its policy does not allow outright.
   * Turning this off means composing `attachments` yourself; sending nothing is
   * what produced "no grant covers this call" denials that read as a
   * misconfigured grant rather than an absent one.
   *
   * The env fallback exists so an operator can turn it off in a deployment they
   * cannot rebuild — the same reason `nodeUrl` and `apiKey` have one.
   */
  attachGrants?: boolean;
  /** How long held grants are cached before re-reading. Default 60s. Fallback: LAYR8_GRANT_CACHE_MS env. */
  grantCacheMs?: number;
  /**
   * Called when a message went out with NO covering grant, or when the grants
   * could not be read.
   *
   * The sender is the only party that knows nothing was attached: the node's
   * denial names the grant it could not find, which sends people to check a
   * grant that is fine. Wire this to a log and the next such incident is one
   * line instead of a day.
   */
  onGrantMiss?: (info: { to: string[]; type: string; error?: unknown }) => void;
}

/** Resolved configuration with required fields guaranteed present. */
export interface ResolvedConfig {
  nodeUrl: string;
  apiKey: string;
  agentDid: string;
  didSpec: Required<DidSpec>;
  attachGrants: boolean;
  grantCacheMs: number;
}

/** Default grant cache TTL. Short: a grant minted seconds ago is invisible until it lapses. */
export const DEFAULT_GRANT_CACHE_MS = 60_000;

/**
 * Env booleans, spelled the way operators spell them. Anything unrecognised —
 * including the empty string an unset-but-exported variable produces — leaves
 * the code default alone, rather than reading as `false`.
 */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
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

  // A non-numeric or negative env value is ignored rather than turned into
  // `NaN`, which would make every comparison false and re-read the credentials
  // on EVERY message — a typo becoming a load problem nobody would connect to it.
  const envCacheMs = Number(process.env.LAYR8_GRANT_CACHE_MS);
  const grantCacheMs =
    cfg.grantCacheMs ??
    (Number.isFinite(envCacheMs) && envCacheMs >= 0 ? envCacheMs : DEFAULT_GRANT_CACHE_MS);

  return {
    nodeUrl: normalizedUrl,
    apiKey,
    agentDid,
    didSpec,
    attachGrants: cfg.attachGrants ?? envBool(process.env.LAYR8_ATTACH_GRANTS) ?? true,
    grantCacheMs,
  };
}
