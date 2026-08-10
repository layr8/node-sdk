import { describe, it, expect, vi } from "vitest";

import {
  MAX_ATTACHED,
  Wallet,
  parseCredential,
  selectFor,
  splitTypeUri,
  toolNameOf,
  type HeldCredential,
} from "../src/wallet.js";

/**
 * Attaching grants to outbound messages.
 *
 * Nothing in this SDK attached one before — there was no enforcement on outgoing
 * requests because there was no mechanism. An agent connecting directly, on any
 * protocol other than MCP through the broker, sent nothing and was denied with
 * "no grant covers this call". That message reads as "your grant is
 * misconfigured", which is where two teams spent days; the truth was that no
 * credential was ever put on the wire.
 */

const PROTO = "https://layr8.io/protocols/notes/1.0";
const AGENT = "did:web:example.com:agents:store";

function held(over: Partial<HeldCredential> = {}): HeldCredential {
  return {
    id: "urn:uuid:vg-1",
    rawJwt: "hdr.payload.sig",
    scope: [{ protocol: PROTO, messageTypes: ["*"], resource: AGENT }],
    tools: [],
    ...over,
  };
}

describe("splitTypeUri", () => {
  it("splits on the LAST slash, as the node's own parser does", () => {
    expect(splitTypeUri(`${PROTO}/space-info`)).toEqual({
      protocol: PROTO,
      messageType: "space-info",
    });
  });

  it("treats a type with no slash as a whole protocol", () => {
    expect(splitTypeUri("ping")).toEqual({ protocol: "ping", messageType: "" });
  });
});

describe("selecting the covering set", () => {
  it("attaches a grant whose scope covers the message", () => {
    const out = selectFor([held()], {
      recipients: [AGENT],
      typeUri: `${PROTO}/space-info`,
    });

    expect(out).toHaveLength(1);
  });

  it("expands a wildcard messageType — the thing the PDP was blamed for", () => {
    // The reported hypothesis was that the policy did not expand
    // `messageTypes: ["*"]`. It does. Pinned here so this side cannot become the
    // reason that hypothesis turns true.
    const out = selectFor([held({ scope: [{ protocol: PROTO, messageTypes: ["*"] }] })], {
      recipients: [AGENT],
      typeUri: `${PROTO}/log-turn`,
    });

    expect(out).toHaveLength(1);
  });

  it("does not attach a grant for a different protocol", () => {
    const out = selectFor([held()], {
      recipients: [AGENT],
      typeUri: "https://layr8.io/protocols/other/1.0/space-info",
    });

    expect(out).toEqual([]);
  });

  it("does not attach a grant for a different recipient", () => {
    const out = selectFor([held()], {
      recipients: ["did:web:example.com:agents:other-one"],
      typeUri: `${PROTO}/space-info`,
    });

    expect(out).toEqual([]);
  });

  it("attaches when ANY recipient is covered", () => {
    // The node decides once per recipient, so a credential covering one of them
    // belongs on the wire.
    const out = selectFor([held()], {
      recipients: ["did:web:example.com:agents:other", AGENT],
      typeUri: `${PROTO}/space-info`,
    });

    expect(out).toHaveLength(1);
  });

  it("honours a prefix resource bound", () => {
    const c = held({ scope: [{ protocol: PROTO, messageTypes: ["*"], resource: "did:web:example.com:agents/*" }] });

    expect(selectFor([c], { recipients: ["did:web:example.com:agents/x"], typeUri: `${PROTO}/t` })).toHaveLength(1);
    expect(selectFor([c], { recipients: ["did:web:elsewhere.com:agents/x"], typeUri: `${PROTO}/t` })).toEqual([]);
  });

  it("honours a bare SEGMENT prefix, as the policy does", () => {
    // the node's policy has a third clause this side was
    // missing: a bare `tables` covers `tables/customers`, requiring the next
    // character to be `/` so it does not also cover `tables_archive`
    // (segment prefix vs non-segment prefix,
    // `test_resource_non_segment_no_match`).
    //
    // The omission pointed the expensive way — withholding a grant the policy
    // would have honoured, which costs a working call and surfaces as the same
    // "no grant covers this call" this file exists to end. It bites nothing
    // today only because the PEP sets the message resource to the recipient DID
    // and a `did:web` has no `/` in it: a premise nothing in the code states.
    const c = held({ scope: [{ protocol: PROTO, messageTypes: ["*"], resource: "tables" }] });

    expect(selectFor([c], { recipients: ["tables"], typeUri: `${PROTO}/t` })).toHaveLength(1);
    expect(selectFor([c], { recipients: ["tables/customers"], typeUri: `${PROTO}/t` })).toHaveLength(1);
    expect(selectFor([c], { recipients: ["tables_archive"], typeUri: `${PROTO}/t` })).toEqual([]);
  });

  describe("the tool allowlist is NOT a filter here", () => {
    // The node's policy allows on the first passing grant and ignores the rest, so an
    // extra credential on the wire costs nothing — while one withheld costs a
    // working call, invisibly, as the same "no grant covers this call" this
    // exists to end.
    //
    // An earlier version filtered on `credentialSubject.grant.tools`, reasoning
    // that the grant's embedded rego would deny anyway. It was the only rule
    // stricter than the policy, and no policy reads `grant.tools` at all — the node
    // evaluates `constraints.rego`, keyed by grant id, which this side cannot
    // reproduce. The filter read `body.params.name` protocol-blind, so any
    // JSON-RPC-shaped body could drop a grant the node would have honoured.
    it("attaches a grant whose allowlist does not name this tool", () => {
      const out = selectFor([held({ tools: ["read"] })], {
        recipients: [AGENT],
        typeUri: `${PROTO}/tools-call`,
        tool: "write",
      });

      expect(out).toHaveLength(1);
    });
  });
});

describe("what goes on the wire stays bounded and distinguishable", () => {
  const jwt = (payload: unknown, sig: string) =>
    `${Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url")}.${Buffer.from(
      JSON.stringify(payload),
    ).toString("base64url")}.${sig}`;

  const anon = (sig: string) =>
    parseCredential({
      credential_jwt: jwt({ credentialSubject: { scope: [{ protocol: PROTO, messageTypes: ["*"] }] } }, sig),
    })!;

  it("gives two id-less credentials DIFFERENT attachment ids", () => {
    // The fallback used to be the head of the JWT, which every credential from
    // one issuer shares — so they all got the same attachment id, and a frame
    // carrying two attachments under one id is a frame whose second attachment
    // may not survive.
    const [a, b] = [anon("c2lnLWFhYQ"), anon("c2lnLWJiYg")];

    expect(a.id).not.toBe(b.id);
  });

  it("caps the set — a per-tool holder must not send 60 JWTs per message", () => {
    const many = Array.from({ length: MAX_ATTACHED + 8 }, (_, i) => anon(`c2ln${i}`));

    expect(selectFor(many, { recipients: [AGENT], typeUri: `${PROTO}/t` })).toHaveLength(MAX_ATTACHED);
  });

  describe("when it caps, the grant most likely to matter keeps its slot", () => {
    // `selectFor` took a `tool` and never read it. Under the cap that left the
    // choice among per-tool grants to the node's row order — and the holding
    // MAX_ATTACHED was written for is exactly that one: dozens of grants
    // identical in protocol, message type and resource, differing only in the
    // tool they name. Thirty of them with the authorising one twentieth meant a
    // silent drop and an `e.m.authz.denied` with nothing to look at.
    //
    // A RANKING, not a filter. Nothing is withheld that the cap has room for:
    // `grant.tools` is not a policy input anywhere — the node evaluates
    // `constraints.rego` keyed by grant id — and an earlier version that
    // filtered on it dropped grants the node would have honoured.

    const others = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        held({ id: `urn:uuid:other-${i}`, tools: [`tool-${i}`] }),
      );

    it("keeps the grant that names THIS tool, read last though it was", () => {
      const mine = held({ id: "urn:uuid:names-this-tool", tools: ["the-one"] });

      const out = selectFor([...others(MAX_ATTACHED + 4), mine], {
        recipients: [AGENT],
        typeUri: `${PROTO}/tools-call`,
        tool: "the-one",
      });

      expect(out).toHaveLength(MAX_ATTACHED);
      expect(out[0].id).toBe("urn:uuid:names-this-tool");
    });

    it("keeps an UNRESTRICTED grant over one that names only other tools", () => {
      const any = held({ id: "urn:uuid:no-tool-bound", tools: [] });

      const out = selectFor([...others(MAX_ATTACHED + 4), any], {
        recipients: [AGENT],
        typeUri: `${PROTO}/tools-call`,
        tool: "the-one",
      });

      expect(out.map((a) => a.id)).toContain("urn:uuid:no-tool-bound");
    });

    it("tells the caller when it left credentials off", () => {
      // Silence here is the same defect in a new place: a credential dropped by
      // the cap and a credential never held produce the SAME denial, and the
      // holder is the only party who can tell them apart.
      const onCapped = vi.fn();

      selectFor(others(MAX_ATTACHED + 4), { recipients: [AGENT], typeUri: `${PROTO}/t` }, onCapped);

      expect(onCapped).toHaveBeenCalledWith({
        covering: MAX_ATTACHED + 4,
        attached: MAX_ATTACHED,
      });
    });

    it("says nothing when everything fits", () => {
      const onCapped = vi.fn();

      selectFor(others(MAX_ATTACHED), { recipients: [AGENT], typeUri: `${PROTO}/t` }, onCapped);

      expect(onCapped).not.toHaveBeenCalled();
    });
  });

  it("when it caps, a LIVE grant keeps its slot over a lapsed one", () => {
    // Validity is the PDP's decision and nothing is withheld for it. But if
    // something must be left off, it should be the entry that has certainly
    // lapsed — not a coin flip decided by read order.
    const dead = Array.from({ length: MAX_ATTACHED }, (_, i) => ({
      ...anon(`c2lnZGVhZA${i}`),
      expiresAt: 1_000,
    }));
    const live = { ...anon("c2lnbGl2ZQ"), expiresAt: 9_000 };

    const out = selectFor([...dead, live], {
      recipients: [AGENT],
      typeUri: `${PROTO}/t`,
      now: 5_000,
    });

    expect(out.map((a) => a.id)).toContain(live.id);
  });

  it("rejects anything that is not a three-segment compact JWS", () => {
    const claims = { credentialSubject: { scope: [{ protocol: PROTO, messageTypes: ["*"] }] } };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");

    expect(parseCredential({ credential_jwt: `hdr.${body}` })).toBeNull();
    expect(parseCredential({ credential_jwt: `hdr.${body}.` })).toBeNull();
    expect(parseCredential({ credential_jwt: `hdr.${body}.sig` })).not.toBeNull();
  });

  it("reads `valid_until` off the record without acting on it", () => {
    // Recorded, and used ONLY as the tiebreak above. A skewed local clock that
    // withheld a live grant would fail silently, which is the failure mode this
    // whole file exists to end.
    const c = parseCredential({
      credential_jwt: jwt({ credentialSubject: { scope: [{ protocol: PROTO, messageTypes: ["*"] }] } }, "c2ln"),
      valid_until: "2020-01-01T00:00:00Z",
    })!;

    expect(c.expiresAt).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(selectFor([c], { recipients: [AGENT], typeUri: `${PROTO}/t` })).toHaveLength(1);
  });
});

describe("the attachment shape", () => {
  it("is the one the node keys on — a wrong MEDIA TYPE is dropped SILENTLY", () => {
    // `media_type` is the only thing the node's extractor filters on: exactly
    // `application/vc+jwt` is kept, everything else is discarded before the data
    // is looked at, and the denial that follows is byte-for-byte the one you get
    // for attaching nothing, which is why the mistake is expensive to find: a
    // hand-built `application/vp+jwt`.
    //
    // `data.base64` is NOT part of that rule — the extractor falls back to it
    // and base64url-decodes it. `data.jws` is still what this SDK writes,
    // because it is the field read first and the one the ecosystem writes; the
    // earlier claim here that the alternative was discarded was simply false,
    // and a confident wrong reason sends the next reader to the wrong place.
    const [att] = selectFor([held({ rawJwt: "a.b.c" })], {
      recipients: [AGENT],
      typeUri: `${PROTO}/space-info`,
    });

    expect(att).toEqual({
      id: "urn:uuid:vg-1",
      media_type: "application/vc+jwt",
      data: { jws: "a.b.c" },
    });
  });
});

describe("parsing what the node stores", () => {
  const jwt = (payload: unknown) =>
    `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  it("reads claims at the top level, and through a `vc` wrapper", () => {
    const claims = {
      id: "urn:uuid:top",
      credentialSubject: { scope: [{ protocol: PROTO, messageTypes: ["*"] }] },
    };

    expect(parseCredential({ credential_jwt: jwt(claims) })?.id).toBe("urn:uuid:top");
    expect(parseCredential({ credential_jwt: jwt({ vc: claims }) })?.id).toBe("urn:uuid:top");
  });

  it("rejects a VRTC — it has `grantable`, not `scope`, and belongs elsewhere", () => {
    // A VRTC goes in the node's control chain. Putting one in `delegation_chain`
    // makes the policy's structure check fail and denies the whole request.
    const vrtc = { id: "urn:uuid:vrtc", credentialSubject: { grantable: ["*"] } };

    expect(parseCredential({ credential_jwt: jwt(vrtc) })).toBeNull();
  });

  it("rejects a record with no JWT rather than inventing one", () => {
    expect(parseCredential({ credential_id: "urn:uuid:x" })).toBeNull();
  });
});

describe("Wallet", () => {
  const jwt = (payload: unknown) =>
    `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  const body = {
    credentials: [
      {
        credential_jwt: jwt({
          id: "urn:uuid:vg-1",
          credentialSubject: { scope: [{ protocol: PROTO, messageTypes: ["*"] }] },
        }),
      },
    ],
  };

  // A reader, not a `fetch` stub: the wallet goes through the SDK's RestClient
  // because that is what resolves `*.localhost` in local development.
  const okReader = () => {
    const get = vi.fn().mockResolvedValue(body);
    return { get, reader: { get } as { get<T>(p: string): Promise<T> } };
  };

  it("reads the holder's grants from the node", async () => {
    const { get, reader } = okReader();
    const w = new Wallet(reader);

    expect(await w.heldBy(AGENT)).toHaveLength(1);
    expect(get.mock.calls[0][0]).toBe(
      `/api/v1/credentials?holder_did=${encodeURIComponent(AGENT)}`,
    );
  });

  it("puts a DEADLINE on the read", async () => {
    // The read sits inside the per-channel write chain, so an unbounded one
    // deadlocks the channel — and `http.request` has no default timeout to end
    // it. Asserted here at the point the option is handed over, because that is
    // the link a refactor can drop while every other test still passes;
    // `rest.test.ts` proves the client honours it.
    const { get, reader } = okReader();

    await new Wallet(reader, 60_000, undefined, 1_234).heldBy(AGENT);

    expect(get.mock.calls[0][1]).toEqual({ timeoutMs: 1_234 });
  });

  it("remembers a failure for at least as long as the deadline", async () => {
    // The failure entry is stamped with the time the read STARTED. A failure TTL
    // at or below the deadline would therefore be lapsed the moment a timeout
    // recorded it, and a hung node would cost EVERY send the full deadline —
    // consecutively, because the write chain serialises them.
    const get = vi.fn().mockRejectedValue(new Error("timed out after 20000ms"));
    const reader = { get } as { get<T>(p: string): Promise<T> };
    const w = new Wallet(reader, 60_000, undefined, 20_000);

    await expect(w.heldBy(AGENT, 0)).rejects.toThrow();
    await expect(w.heldBy(AGENT, 19_000)).rejects.toThrow();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("caches, so a send does not cost a round trip", async () => {
    const { get, reader } = okReader();
    const w = new Wallet(reader);

    await w.heldBy(AGENT);
    await w.heldBy(AGENT);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL has passed", async () => {
    // The TTL is the whole freshness story: a grant minted seconds ago is
    // invisible until it lapses. Asserted so nobody raises it to an hour
    // thinking it is only a performance knob.
    const { get, reader } = okReader();
    const w = new Wallet(reader, 1_000);

    await w.heldBy(AGENT, 0);
    await w.heldBy(AGENT, 2_000);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("refresh() drops the cache for a caller that was just granted something", async () => {
    const { get, reader } = okReader();
    const w = new Wallet(reader);

    await w.heldBy(AGENT);
    w.refresh(AGENT);
    await w.heldBy(AGENT);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("costs ONE read for N concurrent callers", async () => {
    // The PROMISE is cached, not the result. Caching the result leaves a window
    // between "cache missed" and "cache written" that every concurrent caller
    // falls into: measured, ten callers at cold start made ten identical HTTP
    // requests. The client's per-channel write chain hides this for same-channel
    // sends, which is why the claim is pinned HERE, where it is actually made.
    const { get, reader } = okReader();
    const w = new Wallet(reader);

    await Promise.all(Array.from({ length: 10 }, () => w.heldBy(AGENT)));

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("remembers a FAILURE briefly — and never as long as a success", async () => {
    // Only caching successes turns a config mistake — an API key that cannot
    // read credentials — into a permanent per-message latency tax on an agent
    // that is otherwise working. Caching it for the full TTL is the opposite
    // mistake: the fix should take effect without a restart.
    const get = vi.fn().mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue(body);
    const w = new Wallet({ get } as { get<T>(p: string): Promise<T> }, 60_000, 5_000);

    await expect(w.heldBy(AGENT, 0)).rejects.toThrow(/500/);
    await expect(w.heldBy(AGENT, 1_000)).rejects.toThrow(/500/);
    expect(get, "a cached failure must not re-ask").toHaveBeenCalledTimes(1);

    expect(await w.heldBy(AGENT, 6_000)).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("throws on a failed read rather than reporting no grants", async () => {
    // "No grants" and "could not ask" are different, and conflating them is the
    // whole reason this file exists. The caller turns it into `onGrantMiss`.
    const reader = { get: vi.fn().mockRejectedValue(new Error("HTTP 503")) };
    const w = new Wallet(reader as { get<T>(p: string): Promise<T> });

    await expect(w.heldBy(AGENT)).rejects.toThrow(/503/);
  });
});

describe("toolNameOf", () => {
  it("finds the name the policy matches, and nothing else", () => {
    expect(toolNameOf({ params: { name: "send_email" } })).toBe("send_email");
    expect(toolNameOf({ params: {} })).toBeUndefined();
    expect(toolNameOf(null)).toBeUndefined();
  });
});

// The source-level wiring checks that used to live here are gone. They asserted
// the code LOOKED like it attached; `attach-grants.test.ts` drives a real client
// against a fake node and reads the attachment off the wire, which is the claim
// that was actually wanted. A grep and a behaviour are not the same evidence.
