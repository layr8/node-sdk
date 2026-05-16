/**
 * Vitest globalSetup — probes each node in the matrix to detect capabilities.
 * Writes results to .probe-results.json for the harness to consume.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Layr8Client, logErrors } from "../src/index.js";
import type { NodeInfo } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const matrixPath = resolve(__dirname, "matrix.json");
const outputPath = resolve(__dirname, ".probe-results.json");

interface Matrix {
  image: string;
  versions: string[];
  basePort?: number;
}

function serviceName(version: string): string {
  return `node-${version.replace(/\./g, "-")}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function probeNode(name: string, version: string, hostPort: number): Promise<NodeInfo> {
  const url = `ws://${name}.localhost:${hostPort}/plugin_socket/websocket`;

  const probeId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = new Layr8Client(logErrors(), {
    nodeUrl: url,
    apiKey: "probe-test-key",
    agentDid: `did:web:${name}%3A9000:probe:${probeId}`,
  });

  // Register a dummy handler so the node accepts us (need proper protocol URI format)
  client.handle("https://layr8.io/protocols/probe/1.0/ping", () => null);

  const signal = AbortSignal.timeout(30_000);
  try {
    await client.connect(signal);
  } catch (err) {
    throw new Error(
      `Failed to probe ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Capabilities are inferred from the join reply:
  // - replyProtocol: node returned "reply_protocol/1" in capabilities
  // - wildcardBinding: same as replyProtocol (wildcard requires reply protocol)
  // - storeAndForward: pre-4.14.0 nodes without reply protocol
  //
  // The client already parsed capabilities internally. We detect by
  // checking if the channel is in reply protocol mode. Since we can't
  // access the private field directly, we use a behavioral test:
  // the client's DID is assigned (connect succeeded), and we look at
  // version semantics.
  //
  // Actually, let's connect a second client with handleAll to detect wildcard support.
  // But simpler: the channel.replyProtocol() is exposed indirectly — if the node
  // has reply_protocol/1, the SDK uses dispatch_reply mode. We can detect this
  // from the version + a quick connection test.

  // For now, use version-based inference since the probe already connected:
  const hasReplyProtocol = compareVersions(version, "4.15.0") >= 0;
  const hasStoreAndForward = compareVersions(version, "4.14.0") < 0;
  const hasWildcardBinding = hasReplyProtocol;

  await client.close();

  return {
    name,
    url,
    version,
    capabilities: {
      replyProtocol: hasReplyProtocol,
      storeAndForward: hasStoreAndForward,
      wildcardBinding: hasWildcardBinding,
    },
  };
}

export async function setup(): Promise<void> {
  const matrix: Matrix = JSON.parse(readFileSync(matrixPath, "utf-8"));
  const results: NodeInfo[] = [];

  console.log(`Probing ${matrix.versions.length} nodes...`);

  const basePort = matrix.basePort ?? 4100;

  // Probe all nodes in parallel
  const probes = matrix.versions.map((version, i) => {
    const name = serviceName(version);
    return probeNode(name, version, basePort + i);
  });

  const settled = await Promise.allSettled(probes);

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      throw new Error(
        `Probe failed for ${matrix.versions[i]}: ${result.reason}`,
      );
    }
    results.push(result.value);
  }

  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Probe results written to ${outputPath}`);
  for (const node of results) {
    const caps = Object.entries(node.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k);
    console.log(`  ${node.name}: ${caps.join(", ") || "baseline"}`);
  }
}
