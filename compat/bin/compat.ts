import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ScenarioContext, SenderContext, ScenarioResult } from "../scenarios/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = resolve(__dirname, "../scenarios");

export function listScenarios(): string[] {
  const files = readdirSync(SCENARIOS_DIR);
  return files
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    .map((f) => f.replace(/\.(ts|js)$/, ""))
    .filter((name) => name !== "types" && !name.startsWith("_"));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "list-scenarios": { type: "boolean", default: false },
      mode: { type: "string" },
      scenario: { type: "string" },
      node: { type: "string" },
      did: { type: "string" },
      "api-key": { type: "string", default: process.env.LAYR8_API_KEY ?? "test-key" },
      timeout: { type: "string", default: "10000" },
      "test-id": { type: "string", default: "cli" },
    },
  });

  if (values["list-scenarios"]) {
    console.log(JSON.stringify(listScenarios()));
    return;
  }

  if (!values.mode || !values.scenario) {
    console.error("--mode and --scenario are required");
    process.exit(2);
  }

  const mod = await import(`../scenarios/${values.scenario}.js`);
  const timeout = parseInt(values.timeout!, 10);

  if (values.mode === "receiver") {
    const ctx: ScenarioContext = {
      nodeUrl: values.node!,
      apiKey: values["api-key"]!,
      testId: values["test-id"]!,
      timeout,
      agentDid: values.did,
    };
    await mod.runReceiver(ctx, (did: string) => {
      console.log(JSON.stringify({ status: "ready", did }));
    });
  } else if (values.mode === "sender") {
    if (!values.did) {
      console.error("--did is required in sender mode");
      process.exit(2);
    }
    // Generate a sender DID from the node URL — the cloud-node
    // rejects empty DIDs, so we must provide one even for senders.
    const nodeHost = new URL(values.node!).hostname;
    const senderDid = `did:web:${nodeHost}%3A9000:compat:sender-${randomUUID()}`;
    const ctx: SenderContext = {
      nodeUrl: values.node!,
      apiKey: values["api-key"]!,
      testId: values["test-id"]!,
      timeout,
      receiverDid: values.did!,
      agentDid: senderDid,
    };
    const result: ScenarioResult = await mod.runSender(ctx);
    console.log(JSON.stringify({
      status: result.status,
      scenario: result.scenario,
      duration_ms: result.duration_ms,
      error: result.error ?? null,
    }));
    if (result.status !== "pass") process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith("compat.ts") ||
               process.argv[1]?.endsWith("compat.js");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}