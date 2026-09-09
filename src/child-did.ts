import { randomBytes } from "node:crypto";
import { Layr8Error } from "./errors.js";

/**
 * Naming a DID that borrows a parent's authority.
 *
 * A join may name the parent whose authority its DID borrows
 * (`DidSpec.parentDid`). The node requires such a DID to be named **beneath**
 * that parent — the parent, then exactly one further segment:
 *
 *     parent  did:web:acme.example:users:alice
 *     child   did:web:acme.example:users:alice:k7m2q9x4h3bd
 *
 * and refuses a join whose DID is not, with the problem code
 * `plugin.child.not-beneath-parent`.
 *
 * ## Why the shape is fixed rather than free
 *
 * A cloud-node API key can restrict which DIDs it may bind. An entry is either
 * an exact DID or a literal prefix with a trailing `*`, so a key can admit a
 * whole FAMILY of DIDs only when that family is a namespace. While a borrower's
 * name was unrelated to its parent, no entry shorter than the borrower's whole
 * DID covered it — and since the name is generated per connection, that entry
 * cannot be written in advance. The only key that admitted a borrower was one
 * with **no restrictions at all**, which admits every DID on the node.
 *
 * Named beneath its parent, the family is `<parent>:*`, and a key carrying the
 * parent plus that one namespace admits the parent and its borrowers and
 * nothing else.
 *
 * The node is the control, not this module. A client that builds its own name
 * reaches the same socket, so the rule is enforced at the join; deriving a
 * conforming name here is what stops a caller having to know the rule.
 *
 * ## The segment: random, and why not the alternatives
 *
 * `randomChildSegment()` returns 12 characters of Crockford base32 — 60 bits
 * from a cryptographic source, in an alphabet that omits `i`, `l`, `o` and `u`
 * so the value survives being read off a screen and typed back.
 *
 * It appears in the node's audit rows, so a person reads it. Two alternatives
 * were considered and both fail on something a reader would care about:
 *
 * - **A counter.** There is no shared state that owns one. Two processes
 *   borrowing from the same parent would allocate the same number, and a
 *   collision here is one connection joining onto another's identity.
 * - **A name the operator supplies.** That is the thing this removes: a caller
 *   that has to hand-build a conforming DID is a caller that can get it wrong,
 *   and the resulting refusal happens at connect time in production.
 *
 * Twelve characters is far more than collision needs (a single parent would
 * need on the order of a billion simultaneous borrowers before a repeat became
 * likely) and short enough to sit in a log line. There is no readable prefix on
 * it: under this rule EVERY segment beneath a parent is a borrower, so a marker
 * saying so would be true of every value it could ever have.
 *
 * The value is generated once, when the configuration is resolved — not per
 * join. A reconnect therefore returns under the same DID, which is what lets
 * the node re-mint the same delegated credentials for it.
 */

/** Crockford base32: the digits and lower-case letters, less `i`, `l`, `o`, `u`. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Characters in a generated segment. 12 × 5 bits = 60 bits. */
export const CHILD_SEGMENT_LENGTH = 12;

/** Who chose the segment of a borrower's DID. */
export type ChildNameSource = "client" | "sdk";

/**
 * A fresh segment for a borrower's DID.
 *
 * Each character consumes exactly five bits of one random byte, so every
 * character is uniformly distributed — a modulo over a 31- or 36-character
 * alphabet would not be.
 */
export function randomChildSegment(): string {
  const bytes = randomBytes(CHILD_SEGMENT_LENGTH);
  let out = "";
  for (let i = 0; i < CHILD_SEGMENT_LENGTH; i++) {
    out += ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

/**
 * The API-key entry covering every DID that may borrow `parentDid`'s authority.
 *
 * Exported because a key is written by hand from it, and a key written with a
 * different pattern is one the node's rule and the key disagree about.
 */
export function didNamespaceOf(parentDid: string): string {
  return `${parentDid}:*`;
}

/**
 * Is `childDid` named beneath `parentDid` — the parent, then exactly one
 * further non-empty segment?
 *
 * `false` for the parent itself, for a sibling that merely starts with the
 * parent's text (`…:users:alicent`), and for a name two segments deeper.
 */
export function isBeneathParent(childDid: string, parentDid: string): boolean {
  if (!childDid || !parentDid) return false;
  const prefix = `${parentDid}:`;
  if (!childDid.startsWith(prefix)) return false;
  const segment = childDid.slice(prefix.length);
  return segment.length > 0 && !segment.includes(":");
}

/** A borrower's DID, and who chose its segment. */
export interface BorrowerDid {
  did: string;
  /**
   * `undefined` when no parent was named — there is no borrower, so there is
   * nobody who chose a borrower's name. Never folded into `"client"`.
   */
  childNameSource?: ChildNameSource;
}

/**
 * Settle the DID a join will use.
 *
 * Three inputs, three outcomes, and the three are kept apart on the wire:
 *
 * - **No parent named.** `did` is returned unchanged and nothing is claimed
 *   about who named it. This rule is about a relationship between two names and
 *   there is only one name here.
 * - **A parent, and no DID.** The caller passes nothing but the parent; a
 *   segment is generated and the result is reported as `"sdk"`.
 * - **A parent and a DID.** The caller named the borrower itself, and the
 *   result is reported as `"client"`. A name that is not beneath the parent
 *   **throws here**, rather than travelling to the node and coming back as a
 *   join refusal at connect time — the node still refuses it, for every client
 *   that is not this one.
 *
 * `childNameSource` reaches the node because the second and third cases are
 * otherwise identical bytes on the socket: a derived name and a hand-built one
 * that happen to conform are indistinguishable, so a malformed borrower DID
 * could not be read as an SDK defect rather than an operator's typo.
 */
export function resolveBorrowerDid(
  did: string,
  parentDid: string | undefined,
): BorrowerDid {
  if (!parentDid) return { did };

  if (!did) {
    return { did: `${parentDid}:${randomChildSegment()}`, childNameSource: "sdk" };
  }

  if (!isBeneathParent(did, parentDid)) {
    throw new Layr8Error(
      `agentDid ${did} is not named beneath its parent ${parentDid}. ` +
        `A DID that borrows a parent's authority must be "${parentDid}:<segment>" ` +
        `(exactly one further segment), and the node refuses a join that is not. ` +
        `Pass parentDid and leave the DID empty to have one generated.`,
    );
  }

  return { did, childNameSource: "client" };
}
