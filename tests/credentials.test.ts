import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Layr8Client } from "../src/client.js";
import { RESTError, RestClient } from "../src/rest.js";
import type { Credential } from "../src/credentials.js";

const TEST_AGENT_DID = "did:web:test.localhost:test-agent";
const TEST_API_KEY = "test-api-key";

/** Start a mock HTTP server and return its URL. Registers cleanup via afterEach. */
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
  // Override the private rest field to point at our mock server
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

describe("signCredential", () => {
  it("sends correct request and returns signed JWT", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/credentials/sign");
      expect(req.method).toBe("POST");
      expect(req.headers["x-api-key"]).toBe(TEST_API_KEY);

      const body = await readBody(req);
      expect(body.issuer_did).toBe(TEST_AGENT_DID);
      expect(body.format).toBe("compact_jwt");
      expect(body.credential).toBeDefined();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signed_credential: "eyJhbGciOiJFZERTQSJ9.test.signature" }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const cred: Credential = {
      id: "urn:uuid:test-123",
      issuer: TEST_AGENT_DID,
      credentialSubject: { id: "customer-abc", org: "testorg" },
    };

    const signed = await client.signCredential(cred);
    expect(signed).toBe("eyJhbGciOiJFZERTQSJ9.test.signature");
  });

  it("uses custom issuerDid and format when provided", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body.issuer_did).toBe("did:web:other.localhost:other-agent");
      expect(body.format).toBe("json");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signed_credential: "{}" }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const cred: Credential = { credentialSubject: { test: true } };

    const signed = await client.signCredential(cred, {
      issuerDid: "did:web:other.localhost:other-agent",
      format: "json",
    });
    expect(signed).toBe("{}");
  });
});

// The node's /api/v1/credentials/sign requires `id` and `issuer` keys on the
// credential and answers 422 "Invalid credential: missing required fields"
// without naming which one is missing. The SDK fills both in before sending.
describe("signCredential fills the credential fields the node requires", () => {
  const URN_UUID = /^urn:uuid:[0-9a-f-]{36}$/;

  /** Sign `cred` against a mock node and return the request body it received. */
  async function sentBody(
    cred: Credential,
    options?: Parameters<Layr8Client["signCredential"]>[1],
  ): Promise<Record<string, any>> {
    let captured: Record<string, any> | undefined;
    const { url, server } = await startMockServer(async (req, res) => {
      captured = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ signed_credential: "eyJ.sig" }));
    });
    activeServer = server;
    await newTestClient(url).signCredential(cred, options);
    if (!captured) throw new Error("mock node received no request body");
    return captured;
  }

  it("fills issuer with the agent DID and a urn:uuid id when both are missing", async () => {
    const cred: Credential = { credentialSubject: { id: "holder" } };
    const snapshot = structuredClone(cred);

    const body = await sentBody(cred);

    expect(body.credential.issuer).toBe(TEST_AGENT_DID);
    expect(body.credential.id).toMatch(URN_UUID);
    expect(body.credential.credentialSubject).toEqual({ id: "holder" });
    expect(body.issuer_did).toBe(TEST_AGENT_DID);
    expect(cred).toEqual(snapshot);
    expect("id" in cred).toBe(false);
    expect("issuer" in cred).toBe(false);
  });

  it("keeps a given id and fills only issuer", async () => {
    const cred: Credential = { id: "urn:uuid:caller-chosen", credentialSubject: { a: 1 } };
    const snapshot = structuredClone(cred);

    const body = await sentBody(cred);

    expect(body.credential.id).toBe("urn:uuid:caller-chosen");
    expect(body.credential.issuer).toBe(TEST_AGENT_DID);
    expect(cred).toEqual(snapshot);
  });

  it("keeps a given issuer and fills only id", async () => {
    const cred: Credential = { issuer: "did:web:given.localhost:issuer", credentialSubject: { a: 1 } };
    const snapshot = structuredClone(cred);

    const body = await sentBody(cred);

    expect(body.credential.issuer).toBe("did:web:given.localhost:issuer");
    expect(body.credential.id).toMatch(URN_UUID);
    expect(cred).toEqual(snapshot);
  });

  it("sends a credential that has both fields exactly as given", async () => {
    const cred: Credential = {
      id: "urn:uuid:caller-chosen",
      issuer: "did:web:given.localhost:issuer",
      credentialSubject: { a: 1 },
    };
    const snapshot = structuredClone(cred);

    const body = await sentBody(cred);

    expect(body.credential).toEqual(snapshot);
    expect(cred).toEqual(snapshot);
  });

  it("fills issuer with options.issuerDid, not the agent DID, when one is given", async () => {
    const body = await sentBody(
      { credentialSubject: { a: 1 } },
      { issuerDid: "did:web:other.localhost:other-agent" },
    );

    expect(body.credential.issuer).toBe("did:web:other.localhost:other-agent");
    expect(body.issuer_did).toBe("did:web:other.localhost:other-agent");
  });

  it("treats empty-string id and issuer as missing", async () => {
    const cred: Credential = { id: "", issuer: "", credentialSubject: { a: 1 } };

    const body = await sentBody(cred);

    expect(body.credential.issuer).toBe(TEST_AGENT_DID);
    expect(body.credential.id).toMatch(URN_UUID);
    expect(cred.id).toBe("");
    expect(cred.issuer).toBe("");
  });

  it("generates a different id for each call", async () => {
    const cred: Credential = { credentialSubject: { a: 1 } };
    const first = await sentBody(cred);
    activeServer?.close();
    const second = await sentBody(cred);

    expect(first.credential.id).not.toBe(second.credential.id);
  });
});

describe("verifyCredential", () => {
  it("sends correct request and returns verified credential", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/credentials/verify");

      const body = await readBody(req);
      expect(body.verifier_did).toBe(TEST_AGENT_DID);
      expect(body.signed_credential).toBe("eyJhbGciOiJFZERTQSJ9.test.sig");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        credential: {
          id: "urn:uuid:test-123",
          credentialSubject: { id: "customer-abc", org: "testorg" },
        },
        headers: { alg: "EdDSA" },
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const result = await client.verifyCredential("eyJhbGciOiJFZERTQSJ9.test.sig");
    expect(result.credential.id).toBe("urn:uuid:test-123");
    expect(result.headers.alg).toBe("EdDSA");
  });

  it("uses custom verifierDid when provided", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body.verifier_did).toBe("did:web:custom.localhost:agent");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ credential: {}, headers: {} }));
    });
    activeServer = server;

    const client = newTestClient(url);
    await client.verifyCredential("jwt", {
      verifierDid: "did:web:custom.localhost:agent",
    });
  });
});

describe("storeCredential", () => {
  it("sends correct request and returns stored credential", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/credentials");
      expect(req.method).toBe("POST");

      const body = await readBody(req);
      expect(body.holder_did).toBe(TEST_AGENT_DID);
      expect(body.credential_jwt).toBe("eyJ0ZXN0.jwt.here");

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "urn:uuid:stored-123",
        holder_did: body.holder_did,
        credential_jwt: body.credential_jwt,
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const result = await client.storeCredential("eyJ0ZXN0.jwt.here");
    expect(result.id).toBe("urn:uuid:stored-123");
  });

  it("includes optional metadata when provided", async () => {
    const validUntil = new Date("2025-12-31T23:59:59.000Z");

    const { url, server } = await startMockServer(async (req, res) => {
      const body = await readBody(req);
      expect(body.holder_did).toBe("did:web:custom.localhost:holder");
      expect(body.issuer_did).toBe("did:web:issuer.localhost:agent");
      expect(body.valid_until).toBeDefined();

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "urn:uuid:stored-456",
        holder_did: body.holder_did,
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    await client.storeCredential("jwt", {
      holderDid: "did:web:custom.localhost:holder",
      issuerDid: "did:web:issuer.localhost:agent",
      validUntil,
    });
  });
});

describe("listCredentials", () => {
  it("sends correct GET request and returns credentials array", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.method).toBe("GET");
      const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
      expect(parsedUrl.searchParams.get("holder_did")).toBe(TEST_AGENT_DID);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        credentials: [
          { id: "cred-1", holder_did: TEST_AGENT_DID, credential_jwt: "jwt1" },
          { id: "cred-2", holder_did: TEST_AGENT_DID, credential_jwt: "jwt2" },
        ],
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const creds = await client.listCredentials();
    expect(creds).toHaveLength(2);
    expect(creds[0].id).toBe("cred-1");
    expect(creds[1].id).toBe("cred-2");
  });
});

describe("getCredential", () => {
  it("sends correct GET request and returns credential", async () => {
    const { url, server } = await startMockServer(async (req, res) => {
      expect(req.url).toBe("/api/v1/credentials/urn%3Auuid%3Atest-123");
      expect(req.method).toBe("GET");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "urn:uuid:test-123",
        holder_did: TEST_AGENT_DID,
        credential_jwt: "jwt-data",
      }));
    });
    activeServer = server;

    const client = newTestClient(url);
    const cred = await client.getCredential("urn:uuid:test-123");
    expect(cred.id).toBe("urn:uuid:test-123");
    expect(cred.credential_jwt).toBe("jwt-data");
  });
});

describe("signCredential REST error", () => {
  it("throws RESTError on 404 with error message", async () => {
    const { url, server } = await startMockServer(async (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No assertion key found for issuer DID" }));
    });
    activeServer = server;

    const client = newTestClient(url);

    try {
      await client.signCredential({ credentialSubject: { test: true } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RESTError);
      const restErr = err as RESTError;
      expect(restErr.statusCode).toBe(404);
      expect(restErr.message).toContain("No assertion key found for issuer DID");
    }
  });
});

describe("the per-call deadline reaches the wire", () => {
  // A `timeoutMs` that a public method accepts and then drops would be worse
  // than not offering one: the caller believes the call is bounded and it is
  // not. Each of these hangs for the full client default (30s, far past the
  // 5s test timeout) if the option is not forwarded to the REST layer.

  /** A server that accepts the request and never answers it. */
  async function silentServer(): Promise<{ url: string; server: Server }> {
    const parked: ServerResponse[] = [];
    const { url, server } = await startMockServer((_req, res) => {
      parked.push(res);
    });
    server.on("close", () => {
      for (const res of parked) res.destroy();
    });
    return { url, server };
  }

  it("bounds every credential call it is passed to", async () => {
    const { url, server } = await silentServer();
    activeServer = server;

    const client = newTestClient(url);
    const deadline = /timed out after 60ms/;

    await expect(
      client.signCredential({ credentialSubject: {} }, { timeoutMs: 60 }),
    ).rejects.toThrow(deadline);
    await expect(
      client.verifyCredential("jwt-data", { timeoutMs: 60 }),
    ).rejects.toThrow(deadline);
    await expect(
      client.storeCredential("jwt-data", { timeoutMs: 60 }),
    ).rejects.toThrow(deadline);
    await expect(client.listCredentials({ timeoutMs: 60 })).rejects.toThrow(deadline);
    await expect(
      client.getCredential("urn:uuid:test-123", { timeoutMs: 60 }),
    ).rejects.toThrow(deadline);
  });
});
