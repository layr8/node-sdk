import { describe, it, expect } from "vitest";
import {
  CHILD_SEGMENT_LENGTH,
  didNamespaceOf,
  isBeneathParent,
  randomChildSegment,
  resolveBorrowerDid,
} from "../src/child-did.js";
import { resolveConfig } from "../src/config.js";

const PARENT = "did:web:acme.example:users:alice";

describe("randomChildSegment", () => {
  it("is the documented length and alphabet", () => {
    const seg = randomChildSegment();
    expect(seg).toHaveLength(CHILD_SEGMENT_LENGTH);
    // Crockford base32: no `i`, `l`, `o` or `u`, so the value survives being
    // read off a screen and typed back.
    expect(seg).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]+$/);
    expect(seg).not.toMatch(/[ilou]/);
  });

  it("does not repeat", () => {
    // Not a statistical claim, a wiring one: a constant, a counter reset per
    // process, or a value derived from the parent alone would all fail here,
    // and each would give two simultaneous borrowers the same identity.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomChildSegment());
    expect(seen.size).toBe(500);
  });

  it("produces a DID segment, with nothing that would need escaping", () => {
    for (let i = 0; i < 100; i++) {
      expect(randomChildSegment()).toMatch(/^[A-Za-z0-9._%-]+$/);
    }
  });
});

describe("isBeneathParent", () => {
  it("accepts the parent plus exactly one segment", () => {
    expect(isBeneathParent(`${PARENT}:k7m2q9x4h3bd`, PARENT)).toBe(true);
    expect(isBeneathParent(`${PARENT}:a`, PARENT)).toBe(true);
  });

  it("refuses the parent itself, a deeper name, and an empty segment", () => {
    expect(isBeneathParent(PARENT, PARENT)).toBe(false);
    expect(isBeneathParent(`${PARENT}:a:b`, PARENT)).toBe(false);
    expect(isBeneathParent(`${PARENT}:`, PARENT)).toBe(false);
  });

  it("refuses a sibling that merely starts with the parent's text", () => {
    expect(isBeneathParent("did:web:acme.example:users:alicent", PARENT)).toBe(false);
    expect(isBeneathParent("did:web:acme.example:users:alicent:x", PARENT)).toBe(false);
  });

  it("refuses an unrelated name — the case this rule exists for", () => {
    expect(isBeneathParent("did:web:acme.example:agents:helper", PARENT)).toBe(false);
  });

  it("refuses empty inputs rather than treating them as a match", () => {
    expect(isBeneathParent("", PARENT)).toBe(false);
    expect(isBeneathParent(`${PARENT}:x`, "")).toBe(false);
  });
});

describe("didNamespaceOf", () => {
  it("is the entry an API key needs, and it admits exactly the borrowers", () => {
    const pattern = didNamespaceOf(PARENT);
    expect(pattern).toBe(`${PARENT}:*`);

    // The node matches such an entry as a literal prefix. Written out here so
    // that a change to either side has to be made against a stated example.
    const prefix = pattern.slice(0, -1);
    expect(`${PARENT}:k7m2q9x4h3bd`.startsWith(prefix)).toBe(true);
    expect(PARENT.startsWith(prefix)).toBe(false);
    expect("did:web:acme.example:users:bob:x".startsWith(prefix)).toBe(false);
    expect("did:web:acme.example:agents:helper".startsWith(prefix)).toBe(false);
  });
});

describe("resolveBorrowerDid", () => {
  it("names no source when no parent was named", () => {
    // There is no borrower, so there is nobody who chose a borrower's name.
    // `undefined` here is not `"client"`.
    const r = resolveBorrowerDid("did:web:acme.example:agents:helper", undefined);
    expect(r.did).toBe("did:web:acme.example:agents:helper");
    expect(r.childNameSource).toBeUndefined();
  });

  it("derives a name beneath the parent when the caller supplies none", () => {
    const r = resolveBorrowerDid("", PARENT);

    expect(isBeneathParent(r.did, PARENT)).toBe(true);
    expect(r.did.startsWith(`${PARENT}:`)).toBe(true);
    expect(r.did.slice(PARENT.length + 1)).toHaveLength(CHILD_SEGMENT_LENGTH);
    expect(r.childNameSource).toBe("sdk");
  });

  it("derives a different name each time", () => {
    expect(resolveBorrowerDid("", PARENT).did).not.toBe(
      resolveBorrowerDid("", PARENT).did,
    );
  });

  it("keeps a conforming name the caller supplied, and says the caller chose it", () => {
    const r = resolveBorrowerDid(`${PARENT}:k7m2q9x4h3bd`, PARENT);
    expect(r.did).toBe(`${PARENT}:k7m2q9x4h3bd`);
    expect(r.childNameSource).toBe("client");
  });

  it("throws on a name that is not beneath its parent", () => {
    expect(() => resolveBorrowerDid("did:web:acme.example:agents:helper", PARENT)).toThrow(
      /not named beneath its parent/,
    );
  });

  it("throws on a name two segments beneath its parent", () => {
    // The API-key namespace would admit this; the node's rule does not.
    expect(() => resolveBorrowerDid(`${PARENT}:a:b`, PARENT)).toThrow(
      /not named beneath its parent/,
    );
  });
});

describe("resolveConfig derives the agent DID from a named parent", () => {
  const base = { nodeUrl: "ws://localhost:4000", apiKey: "key" };

  it("fills agentDid from the parent when the caller passes only a parent", () => {
    const cfg = resolveConfig({ ...base, didSpec: { parentDid: PARENT } });

    expect(isBeneathParent(cfg.agentDid, PARENT)).toBe(true);
    expect(cfg.didSpec.childNameSource).toBe("sdk");
  });

  it("leaves an unparented agentDid and its empty source alone", () => {
    const cfg = resolveConfig({ ...base, agentDid: "did:web:acme.example:agents:helper" });

    expect(cfg.agentDid).toBe("did:web:acme.example:agents:helper");
    expect(cfg.didSpec.childNameSource).toBe("");
  });

  it("records a caller-supplied conforming DID as the caller's", () => {
    const cfg = resolveConfig({
      ...base,
      agentDid: `${PARENT}:k7m2q9x4h3bd`,
      didSpec: { parentDid: PARENT },
    });

    expect(cfg.agentDid).toBe(`${PARENT}:k7m2q9x4h3bd`);
    expect(cfg.didSpec.childNameSource).toBe("client");
  });

  it("refuses a caller-supplied DID that is not beneath the parent", () => {
    expect(() =>
      resolveConfig({
        ...base,
        agentDid: "did:web:acme.example:agents:helper",
        didSpec: { parentDid: PARENT },
      }),
    ).toThrow(/not named beneath its parent/);
  });

  it("settles the DID once, so a reconnect returns under the same name", () => {
    // The value lives on the resolved config, not on each join. A per-join
    // segment would leave the node minting delegated credentials for a
    // different identity on every reconnect.
    const cfg = resolveConfig({ ...base, didSpec: { parentDid: PARENT } });
    const first = cfg.agentDid;
    expect(cfg.agentDid).toBe(first);
  });
});
