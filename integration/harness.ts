/**
 * Integration test harness — loads probe results and provides
 * filtered node pairings for test parameterization.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeResultsPath = resolve(__dirname, ".probe-results.json");

export interface NodeInfo {
  name: string;
  url: string;
  version: string;
  capabilities: {
    replyProtocol: boolean;
    storeAndForward: boolean;
    wildcardBinding: boolean;
  };
}

export interface Pairing {
  sender: NodeInfo;
  receiver: NodeInfo;
}

let cachedNodes: NodeInfo[] | null = null;

export function getNodes(): NodeInfo[] {
  if (cachedNodes) return cachedNodes;
  const data = readFileSync(probeResultsPath, "utf-8");
  cachedNodes = JSON.parse(data) as NodeInfo[];
  return cachedNodes;
}

export function getPairings(filter?: {
  senderNode?: Partial<NodeInfo["capabilities"]>;
  receiverNode?: Partial<NodeInfo["capabilities"]>;
}): Pairing[] {
  const nodes = getNodes();
  const pairings: Pairing[] = [];

  for (const sender of nodes) {
    if (filter?.senderNode && !matchesCapabilities(sender, filter.senderNode)) {
      continue;
    }
    for (const receiver of nodes) {
      if (filter?.receiverNode && !matchesCapabilities(receiver, filter.receiverNode)) {
        continue;
      }
      pairings.push({ sender, receiver });
    }
  }

  return pairings;
}

function matchesCapabilities(
  node: NodeInfo,
  required: Partial<NodeInfo["capabilities"]>,
): boolean {
  for (const [key, value] of Object.entries(required)) {
    if (node.capabilities[key as keyof NodeInfo["capabilities"]] !== value) {
      return false;
    }
  }
  return true;
}
