import { Layr8Error } from "./errors.js";

/** Configuration for a Layr8 client. */
export interface Config {
  /** WebSocket URL of the Layr8 cloud-node. Fallback: LAYR8_NODE_URL env. */
  nodeUrl?: string;
  /** Authentication key for the cloud-node. Fallback: LAYR8_API_KEY env. */
  apiKey?: string;
  /** DID identity of this agent. If empty, an ephemeral DID is created on connect(). Fallback: LAYR8_AGENT_DID env. */
  agentDid?: string;
}

/** Resolved configuration with required fields guaranteed present. */
export interface ResolvedConfig {
  nodeUrl: string;
  apiKey: string;
  agentDid: string;
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
  if (!apiKey) {
    throw new Layr8Error(
      "apiKey is required (set in Config or LAYR8_API_KEY env)",
    );
  }

  return { nodeUrl, apiKey, agentDid };
}
