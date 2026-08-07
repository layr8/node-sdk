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

/**
 * What `onGrantMiss` is told.
 *
 * ONE definition, exported, because there were two: a hand-written literal on
 * `Config.onGrantMiss` and another on the client's private field. They drifted —
 * the public one was missing `denialCode`, the field the whole callback exists
 * to deliver and the one the README's example destructures, so copying that
 * example out of the README failed to compile while working perfectly at
 * runtime.
 */
export interface GrantMissInfo {
  /** The message's recipients. */
  to: string[];
  /** The message's DIDComm type. */
  type: string;
  /**
   * The node's denial code, when this fired because a denial came back for a
   * message that went out with nothing attached.
   */
  denialCode?: string;
  /** Set when the grants could not be READ at all — never a normal outcome. */
  error?: unknown;
  /**
   * Set when the covering set was CAPPED: more credentials covered this message
   * than `MAX_ATTACHED` allows on one frame, so some were left off. The policy
   * allows on the first passing grant, so the one that mattered may be among
   * the ones dropped.
   */
  capped?: { covering: number; attached: number };
}

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
   * Deadline on the credential read that precedes a send. Default 2s.
   * Fallback: LAYR8_GRANT_READ_TIMEOUT_MS env.
   *
   * The read sits inside the per-channel write chain, because the write order
   * has to be the call order. That makes an unbounded read a channel-wide
   * deadlock: a node that accepts the TCP connection and never answers stops
   * EVERY later send on that channel, including sends that carry their own
   * attachments and never touch the wallet. Node's `http.request` has no
   * default timeout, so without this there is nothing to end the wait.
   *
   * Timing out is treated as a read failure — the message goes out unattached
   * and `onGrantMiss` says so, which is what happens on any other read error.
   *
   * @see `Wallet`'s failure cache, which is deliberately kept at least this
   * long: a hung node must cost one stalled send per failure window, not one
   * per message.
   */
  grantReadTimeoutMs?: number;
  /**
   * Called when a message went out with NO covering grant, when the covering
   * set had to be capped, or when the grants could not be read.
   *
   * The sender is the only party that knows nothing was attached: the node's
   * denial names the grant it could not find, which sends people to check a
   * grant that is fine. Wire this to a log and the next such incident is one
   * line instead of a day.
   */
  onGrantMiss?: (info: GrantMissInfo) => void;
}

/** Resolved configuration with required fields guaranteed present. */
export interface ResolvedConfig {
  nodeUrl: string;
  apiKey: string;
  agentDid: string;
  didSpec: Required<DidSpec>;
  attachGrants: boolean;
  grantCacheMs: number;
  grantReadTimeoutMs: number;
}

/** Default grant cache TTL. Short: a grant minted seconds ago is invisible until it lapses. */
export const DEFAULT_GRANT_CACHE_MS = 60_000;

/**
 * Default deadline on the credential read.
 *
 * Two seconds, chosen from both ends:
 *
 * - It is a JSON GET to the same node this client already holds a WebSocket to,
 *   so the honest answer arrives in milliseconds. Two seconds survives a cold
 *   node, a container still warming its connection pool, and a GC pause, and
 *   still leaves plenty of room before anything a human would call "hung".
 * - It sits comfortably under the wallet's 5s failure cache, which is measured
 *   from the START of the read. A timeout at or above that TTL would leave the
 *   failure lapsed the moment it was recorded, so every single send would pay
 *   the full deadline instead of one per window.
 *
 * Configurable because the second point is the kind of relationship a deployment
 * on a slow link needs to be able to move; the wallet keeps its failure cache at
 * least as long as this value so raising it does not silently undo the first.
 */
export const DEFAULT_GRANT_READ_TIMEOUT_MS = 2_000;

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

  return {
    nodeUrl: normalizedUrl,
    apiKey,
    agentDid,
    didSpec,
    attachGrants: cfg.attachGrants ?? envBool(process.env.LAYR8_ATTACH_GRANTS) ?? true,
    grantCacheMs: envMs(cfg.grantCacheMs, process.env.LAYR8_GRANT_CACHE_MS, DEFAULT_GRANT_CACHE_MS),
    // Zero is not accepted here, unlike the cache TTL where it means "never
    // cache": a zero deadline would abort every read before it started, turning
    // a mistyped variable into an agent that attaches nothing at all — the exact
    // failure this whole feature exists to end.
    grantReadTimeoutMs: envMs(
      cfg.grantReadTimeoutMs,
      process.env.LAYR8_GRANT_READ_TIMEOUT_MS,
      DEFAULT_GRANT_READ_TIMEOUT_MS,
      1,
    ),
  };
}

/**
 * A millisecond setting, from the explicit config or the environment.
 *
 * A non-numeric or out-of-range env value is IGNORED rather than turned into
 * `NaN`, which would make every comparison false and re-read the credentials on
 * EVERY message — a typo becoming a load problem nobody would connect to it.
 */
function envMs(
  explicit: number | undefined,
  raw: string | undefined,
  fallback: number,
  min = 0,
): number {
  if (explicit !== undefined) return explicit;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}
