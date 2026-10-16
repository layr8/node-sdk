/**
 * Boundary test, node-sdk side, for `layr8/contracts`
 * `cn-plugin-delivery-authorization.md`.
 *
 * The fixture is the `context` cloud-node's boundary test asserts it pushes
 * for an allow by grant
 * (`l8_server/test/l8_server_web/channels/plugin_delivery_authorization_contract_test.exs`).
 * What this side owes: the key survives parsing exactly as sent, and the three
 * cases — an object, absent, null — stay three.
 */
import { describe, it, expect } from "vitest";
import { parseDIDComm } from "../src/message.js";
import type { DeliveryAuthorization } from "../src/index.js";

const ALLOW_BY_GRANT: DeliveryAuthorization = {
  decision: "allow",
  reason: "allowed by grant",
  matched_grant_id: "urn:uuid:grant-readonly",
  identity_credentials: [
    {
      id: "urn:uuid:cred-1",
      issuer: "did:web:node.example",
      type: ["VerifiableCredential", "CloudAccessIdentity"],
      valid_until: "2099-01-01T00:00:00Z",
      expiry: "declared",
    },
    {
      id: "urn:uuid:cred-2",
      issuer: "did:web:node.example",
      type: ["VerifiableCredential", "CloudAccessIdentity"],
      valid_until: null,
      expiry: "not_read",
    },
  ],
};

function envelope(context: Record<string, unknown> | undefined) {
  return {
    ...(context ? { context } : {}),
    plaintext: {
      id: "m-1",
      type: "https://layr8.io/protocols/cloud-token/1.0/redeem-readonly",
      from: "did:web:agent",
      to: ["did:web:credx"],
      body: {},
    },
  };
}

describe("context.authorization", () => {
  it("an allow by grant survives parsing exactly as the node sent it", () => {
    const msg = parseDIDComm(
      envelope({ recipient: "did:web:credx", authorization: ALLOW_BY_GRANT }),
    );
    expect(msg.context!.authorization).toEqual(ALLOW_BY_GRANT);
  });

  it("an allow no grant decided keeps its null grant", () => {
    const auth = { decision: "allow", reason: "allowed by allow rule", matched_grant_id: null, identity_credentials: [] };
    const msg = parseDIDComm(envelope({ recipient: "did:web:credx", authorization: auth }));
    expect(msg.context!.authorization).toEqual(auth);
    expect(msg.context!.authorization!.matched_grant_id).toBeNull();
  });

  it("no decision stays absent: no key, not null, not an object", () => {
    const msg = parseDIDComm(envelope({ recipient: "did:web:credx" }));
    expect(msg.context).toBeDefined();
    expect("authorization" in msg.context!).toBe(false);
  });

  it("a null the node sent stays null, not absent", () => {
    const msg = parseDIDComm(envelope({ recipient: "did:web:credx", authorization: null }));
    expect("authorization" in msg.context!).toBe(true);
    expect(msg.context!.authorization).toBeNull();
  });

  it("the three are pairwise distinct", () => {
    const read = (ctx: Record<string, unknown>) => {
      const c = parseDIDComm(envelope(ctx)).context!;
      return "authorization" in c ? JSON.stringify(c.authorization) : "<absent>";
    };
    const values = [
      read({ recipient: "r", authorization: ALLOW_BY_GRANT }),
      read({ recipient: "r" }),
      read({ recipient: "r", authorization: null }),
    ];
    expect(new Set(values).size).toBe(3);
  });

  it("the expiry states reach the caller unchanged", () => {
    const msg = parseDIDComm(
      envelope({ recipient: "did:web:credx", authorization: ALLOW_BY_GRANT }),
    );
    const creds = msg.context!.authorization!.identity_credentials;
    expect(creds.map((c) => [c.expiry, c.valid_until])).toEqual([
      ["declared", "2099-01-01T00:00:00Z"],
      ["not_read", null],
    ]);
  });

  it("field names stay snake_case as the node sent them; nothing is camelCased", () => {
    const msg = parseDIDComm(
      envelope({ recipient: "did:web:credx", authorization: ALLOW_BY_GRANT }),
    );
    const auth = msg.context!.authorization as unknown as Record<string, unknown>;
    expect(Object.keys(auth).sort()).toEqual(
      ["decision", "identity_credentials", "matched_grant_id", "reason"],
    );
    const cred = (auth.identity_credentials as Record<string, unknown>[])[0];
    expect(Object.keys(cred).sort()).toEqual(["expiry", "id", "issuer", "type", "valid_until"]);
  });
});
