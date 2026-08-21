/**
 * Attaching an **identity credential** — a credential about *who the sender
 * is*, not about what it may do.
 *
 * An identity credential rides in the same `attachments` array, with the same
 * `media_type`, as a Verifiable Grant. cloud-node tells the two apart on one
 * test — `credentialSubject.scope`: present and non-empty is a grant and feeds
 * the grant input; absent or empty is an identity credential and feeds the
 * sender-credentials input, where a grant's `constraints.senderCredentials`
 * can see it.
 *
 * ## Why this is a separate path, not a wallet feature
 *
 * The wallet SELECTS grants: it ranks candidates by how well their `scope`
 * covers the outbound message. An identity credential has no scope, so it
 * cannot be ranked, and there is nothing here for the wallet to select BY
 * either — the requirement it would have to satisfy (`senderCredentials`)
 * lives in the grant held by the RECIPIENT and never reaches the sender before
 * the call.
 *
 * So an SDK that chose identity credentials automatically would have exactly
 * one implementable behaviour: attach everything the holder has. That is a
 * disclosure decision wearing the costume of a convenience feature. Which
 * claims about a person or an organisation a counterparty gets to see is the
 * holder's call, made per message.
 *
 * **The caller names the credential. This module only builds the envelope.**
 *
 *     const [cred] = await client.listCredentials();
 *     await client.send({
 *       to: [peer],
 *       type: SOME_TYPE,
 *       body: {},
 *       attachments: [identityAttachment(cred.credential_jwt)],
 *     });
 *
 * Attaching one does NOT cost the message its grants: `withGrants` appends the
 * wallet's selection after attachments that are all identity credentials. See
 * the comment there.
 */

import type { Attachment } from "./message.js";

/**
 * The only media type the node's credential extractor keeps, matched by exact
 * string equality. Everything else — including `application/vp+jwt`, the
 * Verifiable Presentation envelope — is dropped in silence, and the denial that
 * follows is byte-for-byte the one for attaching nothing at all.
 */
export const CREDENTIAL_MEDIA_TYPE = "application/vc+jwt";

/**
 * Deliberately a local copy of `wallet.ts`'s decoder rather than an import.
 *
 * The identity path runs BESIDE the grant wallet, not through it — that is the
 * contract's rule, and importing from `wallet.ts` would quietly make this path
 * depend on a module whose job is grant selection. Ten lines of JWT base64url
 * is the cheaper coupling to avoid.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const seg = jwt.split(".")[1];
  if (!seg) return null;
  const pad = "=".repeat((4 - (seg.length % 4)) % 4);
  const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  // A JSON scalar or array parses without throwing and has no
  // `credentialSubject` to read — which is indistinguishable, downstream, from
  // a credential that simply has no scope. It is not one. `null` here, so the
  // caller can tell "no scope" from "nothing I could read".
  if (!isRecord(parsed)) return null;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a compact JWS is, by the same test the node routes on.
 *
 * THREE outcomes, not two. `credentialSubject.scope` present and non-empty is a
 * grant; absent or empty is an identity credential; a payload that does not
 * decode is **neither**.
 *
 * The third one is why this is not a boolean. A decoder that answers `[]` both
 * for "this credential has no scope" and for "I could not read this at all"
 * makes an undecodable attachment indistinguishable from an identity
 * credential. That is not a cosmetic conflation: identity credentials are the
 * one attachment shape that does NOT stand the wallet aside, so a caller who
 * attached three dots and a shrug would get the wallet's grants appended to its
 * message — a disclosure it never asked for, chosen silently, which is the
 * exact thing the explicit-selection rule exists to forbid. Every other foreign
 * attachment displaces the wallet; something unreadable has to behave like the
 * rest of them, not like the privileged case.
 *
 * Claims are at the TOP LEVEL of the payload on this node; the `vc` wrapper is
 * the standard alternative and both are accepted — same as `parseCredential`.
 */
type CredentialShape = "grant" | "identity" | "undecodable";

function credentialShape(jws: string): CredentialShape {
  const payload = decodeJwtPayload(jws);
  if (payload === null) return "undecodable";
  const vc = isRecord(payload.vc) ? payload.vc : payload;
  const cs = isRecord(vc.credentialSubject) ? vc.credentialSubject : {};
  const scope = Array.isArray(cs.scope) ? (cs.scope as unknown[]) : [];
  return scope.length > 0 ? "grant" : "identity";
}

/**
 * Build the attachment that carries one identity credential.
 *
 * `credentialJws` is the credential itself — the compact JWS, which
 * `listCredentials()` returns as `credential_jwt`. It is not a credential id:
 * an id would mean a read from the node, and this runs inside the per-channel
 * write chain where an unbounded read deadlocks the channel (the reason
 * `Config.grantReadTimeoutMs` exists). A JWS also lets a caller attach a
 * credential the node's store has never seen.
 *
 * Throws, rather than returning something the far end will misread, when:
 *
 * - the argument is not a compact JWS (three segments, non-empty signature).
 *   The node cannot verify anything else, so putting it on the wire only buys a
 *   denial that names the wrong problem.
 * - the credential carries a non-empty `credentialSubject.scope`. That is a
 *   GRANT. cloud-node would route it as a grant, it would not
 *   satisfy a `senderCredentials` requirement, and the resulting denial is
 *   indistinguishable from having attached nothing. The check is local, exact
 *   and free — refusing here is the difference between a stack trace at the
 *   call site and a silent misroute diagnosed at the far end. Grants belong to
 *   the wallet, which selects and caps them; this path does neither.
 */
export function identityAttachment(credentialJws: string): Attachment {
  const parts = typeof credentialJws === "string" ? credentialJws.split(".") : [];
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(
      "identityAttachment: expected a compact JWS (three non-empty dot-separated segments)",
    );
  }

  const shape = credentialShape(credentialJws);

  if (shape === "undecodable") {
    throw new Error(
      "identityAttachment: expected a compact JWS whose payload segment is base64url-encoded " +
        "JSON object. Three segments is not the same as three READABLE segments: a payload " +
        "that does not decode says nothing about `credentialSubject.scope`, so nothing here " +
        "can show it to be an identity credential rather than a grant.",
    );
  }

  if (shape === "grant") {
    throw new Error(
      "identityAttachment: this credential has a non-empty `credentialSubject.scope`, " +
        "so it is a Verifiable Grant, not an identity credential. cloud-node would route it " +
        "as a grant and it would never satisfy a `senderCredentials` requirement. " +
        "Let the wallet attach grants, or pass it in `attachments` yourself.",
    );
  }

  // Non-null: `shape` is "identity", so the payload decoded to an object.
  const payload = decodeJwtPayload(credentialJws) as Record<string, unknown>;
  const vc = isRecord(payload.vc) ? payload.vc : payload;
  const id = (vc.id ?? payload.jti) as string | undefined;

  return {
    // The SIGNATURE segment as the fallback, not the head of the JWT: every
    // credential from one issuer shares a header, so a head-derived id gives
    // them all the SAME attachment id — and a frame carrying two attachments
    // with one id is a frame whose second attachment may not survive.
    id: typeof id === "string" && id !== "" ? id : `urn:jws:${parts[2].slice(0, 32)}`,
    media_type: CREDENTIAL_MEDIA_TYPE,
    data: { jws: credentialJws },
  };
}

/**
 * Is this attachment an identity credential — by the same test cloud-node
 * routes on, applied to what is actually on the message?
 *
 * Used by `withGrants` to decide whether caller-supplied attachments should
 * still displace the wallet. Nothing here trusts how the attachment was built:
 * a hand-assembled one counts exactly the same.
 *
 * False for an attachment whose `jws` does not decode, as well as for one that
 * carries a scope. Only a credential this can actually READ as scope-free is an
 * identity credential; see `credentialShape`.
 */
export function isIdentityAttachment(att: Attachment | undefined): boolean {
  if (!att || att.media_type !== CREDENTIAL_MEDIA_TYPE) return false;
  const jws = att.data?.jws;
  if (typeof jws !== "string" || jws.split(".").length !== 3) return false;
  return credentialShape(jws) === "identity";
}
