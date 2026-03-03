import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Layr8Client } from "../src/client.js";
import { RestClient } from "../src/rest.js";

const TEST_AGENT_DID = "did:web:test.localhost:test-agent";
const TEST_API_KEY = "test-api-key";

/** Start a mock HTTP server and return its URL. */
function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ url: `http://127.0.0.1:${addr.port}`, server });
      }
    });
  });
}

/** Create a Layr8Client wired to a mock HTTP server URL. */
function newTestClient(mockUrl: string): Layr8Client {
  const client = new Layr8Client(() => {}, {
    nodeUrl: "ws://test.localhost:4000",
    apiKey: TEST_API_KEY,
    agentDid: TEST_AGENT_DID,
  });
  (client as any).rest = new RestClient(mockUrl, TEST_API_KEY);
  return client;
}

/** Collect the request body as a parsed JSON object. */
function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(JSON.parse(data)));
  });
}

let activeServer: Server | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
});

describe("signPresentation", () => {
  it("sends correct request and returns signed VP JWT", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/presentations/sign");
      expect(req.method).toBe("POST");

      const body = await readBody(req);
      expect(body.holder_did).toBe(TEST_AGENT_DID);
      expect(body.format).toBe("compact_jwt");
      expect(body.credentials).toEqual(["jwt1", "jwt2"]);
      expect(body.nonce).toBeUndefined();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signed_presentation: "eyJhbGciOiJFZERTQSJ9.vp.sig" }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const signed = await client.signPresentation(["jwt1", "jwt2"]);
    expect(signed).toBe("eyJhbGciOiJFZERTQSJ9.vp.sig");
  });

  it("uses custom options when provided", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body.holder_did).toBe("did:web:custom.localhost:holder");
      expect(body.format).toBe("json");
      expect(body.nonce).toBe("challenge-123");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signed_presentation: "{}" }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const signed = await client.signPresentation(["jwt1"], {
      holderDid: "did:web:custom.localhost:holder",
      format: "json",
      nonce: "challenge-123",
    });
    expect(signed).toBe("{}");
  });
});

describe("verifyPresentation", () => {
  it("sends correct request and returns verified presentation", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/presentations/verify");
      expect(req.method).toBe("POST");

      const body = await readBody(req);
      expect(body.verifier_did).toBe(TEST_AGENT_DID);
      expect(body.signed_presentation).toBe("eyJ.vp.sig");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        presentation: {
          type: ["VerifiablePresentation"],
          verifiableCredential: ["jwt1"],
        },
        headers: { alg: "EdDSA" },
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const result = await client.verifyPresentation("eyJ.vp.sig");
    expect(result.headers.alg).toBe("EdDSA");
    expect(result.presentation.type).toEqual(["VerifiablePresentation"]);
  });

  it("uses custom verifierDid when provided", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body.verifier_did).toBe("did:web:custom.localhost:verifier");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ presentation: {}, headers: {} }));
    });
    activeServer = server;

    const client = newTestClient(url);
    await client.verifyPresentation("jwt", {
      verifierDid: "did:web:custom.localhost:verifier",
    });
  });
});
