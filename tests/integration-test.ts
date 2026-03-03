// Comprehensive integration test for the Layr8 Node SDK.
//
// Tests all key SDK functions against live cloud-nodes:
//   - Layr8Client constructor / logErrors
//   - handle (register handlers)
//   - connect / close / did
//   - send (server-acked)
//   - request (cross-node request/response)
//   - W3C Credentials: sign, verify, store, list, get
//   - W3C Presentations: sign, verify
//
// Prerequisites:
//   - Two nodes running in local Tilt env (alice-test, bob-test)
//   - Traefik exposing *.localhost (k3d maps host :80/:443 to Traefik)
//
// Usage:
//
//   npx tsx tests/integration-test.ts

import { Layr8Client, logErrors, unmarshalBody } from "../src/index.js";
import type { Credential } from "../src/credentials.js";
import type { Message } from "../src/message.js";

const ALICE_NODE_URL = "ws://alice-test.localhost/plugin_socket/websocket";
const ALICE_API_KEY = "alice_abcd1234_testkeyalicetestkeyali24";
const BOB_NODE_URL = "ws://bob-test.localhost/plugin_socket/websocket";
const BOB_API_KEY = "bob_efgh5678_testkeybobbtestkeybobt24";

const ECHO_BASE = "https://layr8.io/protocols/echo-test/1.0";
const ECHO_REQUEST = ECHO_BASE + "/request";
const ECHO_RESPONSE = ECHO_BASE + "/response";

interface EchoReq {
  message: string;
  timestamp: number;
}

interface EchoResp {
  echo: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// ANSI color codes (matches Go SDK)
// ---------------------------------------------------------------------------
const colorReset = "\x1b[0m";
const colorGreen = "\x1b[32m";
const colorRed = "\x1b[31m";
const colorYellow = "\x1b[33m";
const colorCyan = "\x1b[36m";
const colorBold = "\x1b[1m";
const colorDim = "\x1b[2m";

let passed = 0;
let failed = 0;
let skipped = 0;

function section(name: string): void {
  console.log(
    `\n${colorBold}${colorCyan}\u2500\u2500 ${name} \u2500\u2500${colorReset}\n`,
  );
}

function pass(name: string): void {
  console.log(
    `    ${colorBold}${colorGreen} PASS ${colorReset} ${name}`,
  );
  passed++;
}

function fail(name: string, reason: string): void {
  console.log(
    `    ${colorBold}${colorRed} FAIL ${colorReset} ${name}`,
  );
  console.log(`         ${colorDim}${reason}${colorReset}`);
  failed++;
}

function skip(name: string, reason: string): void {
  console.log(
    `    ${colorBold}${colorYellow} SKIP ${colorReset} ${name}`,
  );
  console.log(`         ${colorDim}${reason}${colorReset}`);
  skipped++;
}

async function main(): Promise<void> {
  const testId = Date.now().toString();
  const aliceDid = `did:web:alice-test.localhost:sdk-test-${testId}`;
  const bobDid = `did:web:bob-test.localhost:sdk-test-${testId}`;

  console.log(
    `\n${colorBold}${colorCyan}=== Layr8 Node SDK \u2014 Integration Test ===${colorReset}`,
  );
  console.log(`${colorDim}Test ID:   ${testId}${colorReset}`);
  console.log(`${colorDim}Alice DID: ${aliceDid}${colorReset}`);
  console.log(`${colorDim}Bob DID:   ${bobDid}${colorReset}`);

  let alice: Layr8Client | null = null;
  let bob: Layr8Client | null = null;

  try {
    // =================================================================
    section("Connection & Identity");
    // =================================================================

    // Test 1: Connect Alice with echo handler
    console.log("  [1] Connect Alice with echo handler");

    alice = new Layr8Client(logErrors(), {
      nodeUrl: ALICE_NODE_URL,
      apiKey: ALICE_API_KEY,
      agentDid: aliceDid,
    });

    alice.handle(ECHO_REQUEST, async (msg: Message): Promise<Message | null> => {
      const req = unmarshalBody<EchoReq>(msg);
      console.log(`  [alice echo] from ${msg.from}: "${req.message}"`);
      return {
        id: "",
        type: ECHO_RESPONSE,
        from: "",
        to: [],
        threadId: "",
        parentThreadId: "",
        body: { echo: req.message, timestamp: Date.now() } satisfies EchoResp,
      };
    });

    try {
      await alice.connect(AbortSignal.timeout(15000));
      pass("Alice connected with echo handler");
    } catch (err) {
      fail(
        "Alice connect",
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }

    // Test 2: DID() returns expected value
    console.log("  [2] did returns expected value");

    if (alice.did === aliceDid) {
      pass(`alice.did = ${alice.did}`);
    } else {
      fail("DID mismatch", `got "${alice.did}", want "${aliceDid}"`);
    }

    // Test 3: Connect Bob with no-op handler
    console.log("  [3] Connect Bob");

    bob = new Layr8Client(logErrors(), {
      nodeUrl: BOB_NODE_URL,
      apiKey: BOB_API_KEY,
      agentDid: bobDid,
    });

    bob.handle(ECHO_REQUEST, async (): Promise<null> => null);

    try {
      await bob.connect(AbortSignal.timeout(15000));
      pass("Bob connected");
    } catch (err) {
      fail("Bob connect", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // =================================================================
    section("Cross-Node Messaging");
    // =================================================================

    // Test 4: Request/Response echo (Bob -> Alice)
    console.log("  [4] Request/Response \u2014 echo protocol (Bob \u2192 Alice)");

    try {
      const resp = await bob.request(
        {
          type: ECHO_REQUEST,
          to: [aliceDid],
          body: {
            message: "Hello from Bob!",
            timestamp: Date.now(),
          } satisfies EchoReq,
        },
        { signal: AbortSignal.timeout(15000) },
      );

      const echoResp = unmarshalBody<EchoResp>(resp);
      if (echoResp.echo === "Hello from Bob!") {
        pass(`echo response: "${echoResp.echo}"`);
      } else {
        fail("echo mismatch", `got "${echoResp.echo}"`);
      }
    } catch (err) {
      fail("echo request", err instanceof Error ? err.message : String(err));
    }

    // =================================================================
    section("W3C Credentials & Presentations");
    // =================================================================

    // Test 5: Sign and Verify a Credential
    console.log("  [5] Sign and verify a credential");

    let signedCred: string | null = null;

    try {
      const cred: Credential = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        type: ["VerifiableCredential"],
        credentialSubject: { id: bobDid, name: "Bob Test User" },
      };

      signedCred = await alice.signCredential(cred);
      if (!signedCred || signedCred.length === 0) {
        fail("signCredential", "returned empty string");
      } else {
        const verified = await alice.verifyCredential(signedCred);
        if (verified.credential && verified.headers) {
          pass(
            `signed credential (${signedCred.length} chars), verified with credential and headers`,
          );
        } else {
          fail(
            "verifyCredential",
            `missing fields: credential=${!!verified.credential}, headers=${!!verified.headers}`,
          );
        }
      }
    } catch (err) {
      if (isFeatureNotDeployed(err)) {
        skip(
          "Sign and verify credential",
          err instanceof Error ? err.message : String(err),
        );
        signedCred = null;
      } else {
        fail(
          "Sign and verify credential",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Test 6: Store, List, Get Credential
    console.log("  [6] Store, list, and get credential");

    if (signedCred) {
      try {
        const stored = await alice.storeCredential(signedCred);
        if (!stored.id || stored.id.length === 0) {
          fail("storeCredential", "returned empty id");
        } else {
          const list = await alice.listCredentials();
          const found = list.some((c) => c.id === stored.id);
          if (!found) {
            fail(
              "listCredentials",
              `stored credential ${stored.id} not found in list (${list.length} items)`,
            );
          } else {
            const fetched = await alice.getCredential(stored.id);
            if (fetched.credential_jwt === signedCred) {
              pass(
                `stored (id=${stored.id}), listed (${list.length} items), fetched matches`,
              );
            } else {
              fail(
                "getCredential",
                "fetched credential_jwt does not match signed credential",
              );
            }
          }
        }
      } catch (err) {
        if (isFeatureNotDeployed(err)) {
          skip(
            "Store, list, get credential",
            err instanceof Error ? err.message : String(err),
          );
        } else {
          fail(
            "Store, list, get credential",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else {
      skip(
        "Store, list, get credential",
        "skipped because signCredential was not available",
      );
    }

    // Test 7: Sign and Verify a Presentation
    console.log("  [7] Sign and verify a presentation");

    if (signedCred) {
      try {
        const signedPres = await alice.signPresentation([signedCred]);
        if (!signedPres || signedPres.length === 0) {
          fail("signPresentation", "returned empty string");
        } else {
          const verifiedPres = await alice.verifyPresentation(signedPres);
          if (verifiedPres.presentation && verifiedPres.headers) {
            pass(
              `signed presentation (${signedPres.length} chars), verified with presentation and headers`,
            );
          } else {
            fail(
              "verifyPresentation",
              `missing fields: presentation=${!!verifiedPres.presentation}, headers=${!!verifiedPres.headers}`,
            );
          }
        }
      } catch (err) {
        if (isFeatureNotDeployed(err)) {
          skip(
            "Sign and verify presentation",
            err instanceof Error ? err.message : String(err),
          );
        } else {
          fail(
            "Sign and verify presentation",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else {
      skip(
        "Sign and verify presentation",
        "skipped because signCredential was not available",
      );
    }
  } finally {
    // Clean up connections
    if (bob) {
      try {
        await bob.close();
      } catch {
        // best-effort cleanup
      }
    }
    if (alice) {
      try {
        await alice.close();
      } catch {
        // best-effort cleanup
      }
    }
  }

  // =================================================================
  // Summary
  // =================================================================
  console.log();
  console.log(
    `${colorBold}${colorCyan}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${colorReset}`,
  );
  console.log(
    `  ${colorBold}${colorGreen}Passed:  ${passed}${colorReset}`,
  );
  if (failed > 0) {
    console.log(
      `  ${colorBold}${colorRed}Failed:  ${failed}${colorReset}`,
    );
  } else {
    console.log(`  Failed:  ${failed}`);
  }
  if (skipped > 0) {
    console.log(
      `  ${colorBold}${colorYellow}Skipped: ${skipped}${colorReset}`,
    );
  }
  console.log(
    `${colorBold}${colorCyan}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${colorReset}`,
  );
  console.log();

  if (failed > 0) {
    process.exit(1);
  }
}

/**
 * Check whether an error looks like a feature-not-deployed REST error
 * (e.g., 404, 501, or connection refused). Used to skip tests gracefully
 * when the credential/presentation APIs are not available on the node.
 */
function isFeatureNotDeployed(err: unknown): boolean {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode: number }).statusCode;
    return code === 404 || code === 501 || code === 503;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("econnrefused") ||
      msg.includes("not found") ||
      msg.includes("not implemented") ||
      msg.includes("fetch failed")
    );
  }
  return false;
}

main().catch((err) => {
  console.error("Unhandled error in integration test:", err);
  process.exit(1);
});
