# PRD: Node SDK — Compat Integration (Layer 1 + Layer 2 Image)

## Problem

The node SDK has a working `integration/` directory with scenarios,
harness, docker-compose cloud-node setup, and vitest tests. However:

1. The capability-probing harness (`global-setup.ts`, `harness.ts`)
   needs to go — we declare support, tests prove it
2. Scenarios construct clients directly with `Pairing` — needs to
   move to factory-based `ScenarioContext`
3. Test organization is by cloud-node capability (`sender-node/`,
   `receiver-node/`, `both/`) — needs to flatten since all
   scenarios run against all declared cloud-node versions
4. No Layer 2 CLI adapter or Dockerfile exists for publishing a
   compat image to `ghcr.io/layr8/node-sdk/compat:{version}`
5. Docker-compose is managed manually — should use testcontainers

## Goal

Restructure `integration/` into `compat/` following hexagonal
architecture. Scenario core logic is invoked by two adapters:
Layer 1 (vitest + testcontainers) and Layer 2 (CLI + Dockerfile).
CI publishes a compat image on every release.

## Current Structure

```
integration/
├── matrix.json              # cloud-node versions + exclusions
├── generate-compose.ts      # docker-compose generator
├── docker-compose.yml       # generated
├── global-setup.ts          # probes nodes for capabilities
├── harness.ts               # pairing logic + capability filtering
├── vitest.config.ts
├── Makefile
├── scenarios/               # scenario core logic
│   ├── echo.ts              #   runEcho(pairing, testId)
│   ├── pass.ts              #   runPass(pairing, testId)
│   ├── wildcard.ts          #   runWildcard(pairing, testId)
│   └── disconnected.ts      #   runDisconnected(pairing, testId)
├── both/                    # tests that run on all pairings
│   └── echo.test.ts
├── sender-node/             # tests filtered by sender capability
│   ├── reply-protocol/
│   │   └── dispatch-reply.test.ts
│   └── legacy/
│       ├── ack-behavior.test.ts
│       └── pass-timeout.test.ts
└── receiver-node/           # tests filtered by receiver capability
    ├── reply-protocol/
    │   ├── pass.test.ts
    │   └── wildcard.test.ts
    ├── store-forward/
    │   └── disconnected.test.ts
    └── no-store-forward/
        └── disconnected.test.ts
```

## Target Structure

```
compat/
├── cloud-nodes.json         # cloud-node version declaration
├── scenarios/               # core — pure domain logic
│   ├── echo.ts              #   runSender(ctx), runReceiver(ctx)
│   ├── pass.ts
│   ├── wildcard.ts
│   └── disconnected.ts
├── tests/                   # adapter: Layer 1 (vitest)
│   ├── setup.ts             #   testcontainers lifecycle
│   ├── echo.test.ts         #   parameterized over cloud-node versions
│   ├── pass.test.ts
│   ├── wildcard.test.ts
│   └── disconnected.test.ts
├── bin/                     # adapter: Layer 2 (CLI)
│   └── compat.ts            #   --mode/--scenario/--node/--did/--list-scenarios
├── Dockerfile               # builds compat image
├── tsconfig.json
└── vitest.config.ts
```

## Scenario Port Refactoring

### Before (current)

Each scenario takes a `Pairing` and constructs its own clients:

```typescript
// scenarios/echo.ts
import { Layr8Client, logErrors } from "../../src/index.js";
import type { Pairing } from "../harness.js";

export async function runEcho(pairing: Pairing, testId: string): Promise<EchoResult> {
  const clientA = new Layr8Client(logErrors(), {
    nodeUrl: pairing.sender.url,
    apiKey: "test-key",
    agentDid: didA,
  });
  // ... constructs clientB, connects both, runs scenario
}
```

### After (target)

Each scenario exports `runSender` and `runReceiver` that take a
factory-based context:

```typescript
// scenarios/echo.ts
import { createMessage } from "@layr8/sdk";
import type { ScenarioContext, SenderContext, ScenarioResult } from "./types.js";

export async function runReceiver(ctx: ScenarioContext): Promise<void> {
  const client = ctx.createClient();
  client.handle(ECHO_TYPE, (msg) =>
    createMessage({ type: ECHO_RESPONSE_TYPE, body: { echo: msg.body, from: client.did } })
  );
  await client.connect(ctx.signal);
}

export async function runSender(ctx: SenderContext): Promise<ScenarioResult> {
  const client = ctx.createClient();
  client.handle(ECHO_TYPE, () => null);
  await client.connect(ctx.signal);
  const start = Date.now();
  try {
    const response = await client.request(
      { type: ECHO_TYPE, to: [ctx.receiverDid], body: { ping: ctx.testId } },
      { signal: ctx.signal },
    );
    const pass = (response?.body as any)?.echo?.ping === ctx.testId;
    return { status: pass ? "pass" : "fail", scenario: "echo", duration_ms: Date.now() - start };
  } catch (err) {
    return { status: "fail", scenario: "echo", duration_ms: Date.now() - start, error: String(err) };
  } finally {
    await client.close();
  }
}
```

### Shared Types

```typescript
// scenarios/types.ts
import type { Layr8Client } from "@layr8/sdk";

export interface ScenarioContext {
  createClient: (did?: string) => Layr8Client;
  testId: string;
  signal: AbortSignal;
}

export interface SenderContext extends ScenarioContext {
  receiverDid: string;
}

export interface ScenarioResult {
  status: "pass" | "fail";
  scenario: string;
  duration_ms: number;
  error?: string;
}
```

## Layer 1 Adapter (vitest + testcontainers)

### Test Setup

```typescript
// tests/setup.ts
// Global setup: start cloud-node containers via testcontainers
// One container per declared version in cloud-nodes.json
// Expose: { version: string, nodeUrl: string }[] to test files
```

### Test Shape

```typescript
// tests/echo.test.ts
import { describe, it, expect } from "vitest";
import { runSender, runReceiver } from "../scenarios/echo.js";
import { cloudNodes } from "./setup.js";

describe("echo", () => {
  describe.each(cloudNodes)("cloud-node $version", ({ version, nodeUrl }) => {
    it("echoes a message and receives correct response", async () => {
      const testId = `echo-${Date.now()}`;
      const signal = AbortSignal.timeout(15_000);

      // Factory wired to this cloud-node
      const createClient = (did?: string) =>
        new Layr8Client(logErrors(), {
          nodeUrl,
          apiKey: "test-key",
          agentDid: did ?? generateDid(nodeUrl, testId),
        });

      const receiverDid = generateDid(nodeUrl, testId + "-receiver");
      const receiverCtx = { createClient, testId, signal };
      const senderCtx = { createClient, testId, signal, receiverDid };

      // Start receiver, wait for ready, then run sender
      await runReceiver(receiverCtx);
      const result = await runSender(senderCtx);
      expect(result.status).toBe("pass");
    });
  });
});
```

### Key differences from current tests

1. **No capability filtering** — every scenario runs against every
   declared cloud-node version. Failures are bugs, not expected skips.
2. **No `Pairing` type** — replaced by `ScenarioContext` with factory.
3. **Testcontainers** instead of docker-compose — tests manage their
   own infrastructure lifecycle.
4. **Flat test directory** — no `sender-node/`, `receiver-node/`,
   `both/` split. One test file per scenario.

### What happens to capability-specific tests?

Current tests like `dispatch-reply.test.ts` and `ack-behavior.test.ts`
test cloud-node-specific behaviors, not SDK compat scenarios. These
have two possible homes:

- **If they test SDK behavior**: fold into a compat scenario (e.g.,
  `dispatch-reply` becomes a scenario that any SDK should implement)
- **If they test cloud-node behavior**: keep in `integration/` as
  node-SDK-specific integration tests, separate from `compat/`

## Layer 2 Adapter (CLI)

### bin/compat.ts

Same runner contract as defined in the orchestrator's PRD:

```
compat --mode sender|receiver --scenario <name> --node <url> --did <did>
compat --list-scenarios
```

Constructs a `ScenarioContext` from CLI args, dynamically imports the
scenario module, calls `runSender` or `runReceiver`.

### --list-scenarios

Reads the `scenarios/` directory, returns JSON array of scenario names.
Self-describing — the orchestrator discovers what this version supports.

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY compat/package.json compat/tsconfig.json ./
COPY compat/scenarios/ ./scenarios/
COPY compat/bin/ ./bin/
RUN npm install && npm run build
LABEL org.opencontainers.image.source=https://github.com/layr8/node-sdk
ENTRYPOINT ["node", "dist/bin/compat.js"]
```

The compat image depends on `@layr8/sdk` from npm (the version being
released), not from local source. This ensures the compat image tests
the published artifact.

**Image**: `ghcr.io/layr8/node-sdk/compat:{version}`

## Cloud-Node Declaration

### compat/cloud-nodes.json

```json
{
  "image": "ghcr.io/layr-8/cloud-node",
  "min": "4.13.0",
  "exclude": {
    "4.14.0": "Accepts reply_protocol from join but doesn't advertise capability"
  }
}
```

Layer 1 resolves against `cloud-node-versions.txt` from the compatibility orchestrator
(fetched as raw GitHub file) to determine which versions to spin up.

## CI Workflow Changes

### On PR / push to main

```yaml
jobs:
  test:
    # ... existing unit tests ...

  compat:
    # Layer 1: spin up cloud-nodes, run compat tests
    steps:
      - run: npm run compat:test
```

### On release tag

```yaml
jobs:
  build:
    # build + unit test

  compat-layer1:
    # Layer 1 compat tests
    needs: build

  publish-sdk:
    # npm publish
    needs: [build, compat-layer1]

  publish-compat-image:
    # docker build + push ghcr.io/layr8/node-sdk/compat:$VERSION
    needs: [build, compat-layer1]

  compat-gate:
    # Layer 2: call the compatibility orchestrator gate workflow
    needs: publish-compat-image
    uses: layr8/the compatibility orchestrator/.github/workflows/gate.yml@main
    with:
      sdk: node
      version: ${{ needs.build.outputs.version }}
```

### Ordering

1. Build + unit test
2. Layer 1 compat (same SDK, in-process, real cloud-nodes)
3. Publish SDK to npm + publish compat image to ghcr.io
4. Layer 2 gate (the compatibility orchestrator runs cross-language matrix)

Layer 2 runs AFTER publishing because it needs the compat image
to exist on ghcr.io. If the gate fails, the SDK is already
published — but the compat matrix shows the failure. This is
acceptable because Layer 1 already validated bottom-side
correctness with the same SDK; Layer 2 failures indicate
cross-language protocol disagreements that need investigation,
not rollback.

## package.json additions

```json
{
  "scripts": {
    "compat:test": "vitest run --config compat/vitest.config.ts",
    "compat:build": "docker build -f compat/Dockerfile -t ghcr.io/layr8/node-sdk/compat:$npm_package_version ."
  }
}
```

## Migration Steps

1. Create `compat/scenarios/types.ts` with `ScenarioContext`,
   `SenderContext`, `ScenarioResult`
2. Refactor each scenario (`echo`, `pass`, `wildcard`, `disconnected`)
   from `Pairing` signature to `ScenarioContext` port
3. Create `compat/tests/setup.ts` with testcontainers cloud-node
   lifecycle
4. Create `compat/tests/*.test.ts` — one per scenario, parameterized
   over cloud-node versions
5. Create `compat/bin/compat.ts` — Layer 2 CLI adapter with
   `--list-scenarios`
6. Create `compat/Dockerfile`
7. Create `compat/cloud-nodes.json`
8. Add `compat:test` and `compat:build` scripts to package.json
9. Update CI workflow for Layer 1 + compat image publish
10. Verify Layer 1 passes locally
11. Delete old `integration/` directory (or keep non-compat tests
    that test cloud-node-specific behaviors)

## README Update

Update the node SDK README.md to document:
- The `compat/` directory structure and hexagonal architecture
- How to run Layer 1 locally (`npm run compat:test`)
- Cloud-node version declaration (`compat/cloud-nodes.json`)
- CI ordering: build → Layer 1 → publish npm → compat image → Layer 2
- That Layer 2 gate failures are informational (SDK already published)
- How to add a new scenario
- How to add support for a new cloud-node version

## Resolved Questions

**Q: Keep `integration/` for non-compat tests (dispatch-reply, ack-behavior)?**

No. Delete `integration/` entirely. The capability-based test split
(sender-node/reply-protocol, receiver-node/store-forward, etc.) was
compensating for not running all scenarios against all cloud-node
versions. Under the new model — declare support, test proves it —
running echo/pass/wildcard/disconnected against every declared
cloud-node version subsumes dispatch-reply, ack-behavior, and
pass-timeout. Those tests become redundant.

**Q: Testcontainers npm package or docker-compose via child_process?**

Use the `testcontainers` npm package:
- No generated docker-compose.yml to manage
- Test lifecycle is self-contained (containers start/stop with tests)
- Parallel test suites get isolated containers
- Consistent pattern across all SDK repos (Go, Python, Elixir all
  have testcontainers equivalents)
- One dev dependency, no shell scripts

**Q: Install @layr8/sdk from npm or copy local source?**

Install from npm. The compat image must test the published artifact —
the same thing users download. If there's a packaging bug (wrong
`files` field, missing export), testing local source would miss it.

```dockerfile
ARG SDK_VERSION
RUN npm install @layr8/sdk@${SDK_VERSION}
```

CI passes the version being released. Compat image is built AFTER
npm publish, which aligns with the CI ordering:
build → Layer 1 → publish npm → build compat image → Layer 2 gate.
