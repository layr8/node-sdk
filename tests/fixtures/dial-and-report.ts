// Dials a node URL with an API key through the SDK's real Connection, and
// prints what the resulting error exposes as one JSON line on stdout.
//
// Run by tests/redact-connection-error.test.ts under Bun, in a child process,
// because the leak it guards against comes from Bun's own WebSocket error
// message — which a Node test process cannot produce.
//
// Usage: bun tests/fixtures/dial-and-report.ts <wsUrl> <apiKey>
import { Connection } from "../../src/connection.js";

const [wsUrl, apiKey] = process.argv.slice(2);
if (!wsUrl || !apiKey) {
  console.error("usage: dial-and-report.ts <wsUrl> <apiKey>");
  process.exit(2);
}

const conn = new Connection(wsUrl, apiKey);
try {
  await conn.dial();
  console.log(JSON.stringify({ dialed: true }));
} catch (e) {
  const err = e as Error & { reason?: string; url?: string };
  console.log(
    JSON.stringify({
      dialed: false,
      name: err.name,
      message: err.message,
      reason: err.reason,
      url: err.url,
      stack: err.stack,
    }),
  );
} finally {
  conn.close();
}
process.exit(0);
