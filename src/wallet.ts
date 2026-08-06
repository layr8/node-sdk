/**
 * Attaching Verifiable Grants to outbound messages.
 *
 * ## Why this exists
 *
 * The node REQUIRES a VG for any message its policy does not allow outright, and
 * until now nothing in this SDK attached one. There was no enforcement on
 * outgoing requests — there was no *mechanism*. The only wallet in the ecosystem
 * lived in the MCP broker, scoped to MCP `tools/call` and to the broker's own
 * DID. So an agent that connected directly, on any other protocol, sent nothing
 * and was denied with
 * "no grant covers this call" — a message that reads as "your grant is
 * misconfigured" when the truth is "no credential was ever put on the wire".
 *
 * That misreading is the expensive part. Two teams spent days on it: checking
 * the grant, the Space policy, whether the PDP expanded `messageTypes: ["*"]`.
 * The sender is the only party that knows it attached nothing, so the sender is
 * the only one that can say so — see `onGrantMiss`.
 *
 * ## The attachment shape is load-bearing
 *
 * `media_type: "application/vc+jwt"` with the compact JWS under `data.jws`.
 * Anything else — base64 in `data.base64`, `application/vp+jwt` — is dropped
 * SILENTLY by the node's credential extractor, and the denial that follows looks
 * identical to having no grant at all.
 *
 * ## Selection mirrors the policy, and deliberately errs wide
 *
 * `covers()` mirrors helix's `structure_v2.rego`: some scope entry must match
 * the protocol, the message type and the resource. What this does NOT do is
 * decide anything the PDP decides — revocation and validity windows are checked
 * there, against sources this side cannot see. Attaching a revoked or expired
 * grant costs one denial; withholding one because a local cache thought it was
 * dead costs a working call, and the failure is silent. The wallet's job is to
 * put on the wire everything that plausibly applies.
 */

/** The attachment shape the node's `CredentialExtractor` keys on. */
export interface VgAttachment {
  id: string;
  media_type: "application/vc+jwt";
  data: { jws: string };
}

interface Scope {
  protocol?: string;
  messageTypes?: string[];
  resource?: string;
}

export interface HeldCredential {
  id: string;
  rawJwt: string;
  scope: Scope[];
  /** Tool allowlist (`credentialSubject.grant.tools`). Empty ⇒ any tool. */
  tools: string[];
}

/** Reads a JSON path from the node. `RestClient` is the SDK's, deliberately. */
export interface CredentialReader {
  get<T>(path: string): Promise<T>;
}

/**
 * A DIDComm `type` is `<protocol>/<messageType>` and the policy matches the two
 * separately. Splitting on the LAST slash is what the node's own parser does.
 */
export function splitTypeUri(typeUri: string): { protocol: string; messageType: string } {
  const cut = typeUri.lastIndexOf("/");
  if (cut <= 0) return { protocol: typeUri, messageType: "" };
  return { protocol: typeUri.slice(0, cut), messageType: typeUri.slice(cut + 1) };
}

/** The tool name the policy will match, if this body carries one. */
export function toolNameOf(body: unknown): string | undefined {
  const params = (body as { params?: unknown } | undefined)?.params as
    | { name?: unknown }
    | undefined;
  return typeof params?.name === "string" ? params.name : undefined;
}

// ── structure_v2.rego mirror ──

function protocolMatches(p: string | undefined, want: string): boolean {
  return p === "*" || p === want;
}

function messageTypeMatches(types: string[] | undefined, want: string): boolean {
  return Array.isArray(types) && (types.includes("*") || types.includes(want));
}

function resourceMatches(r: string | undefined, want: string): boolean {
  if (r == null || r === "" || r === "*") return true;
  if (r.endsWith("/*")) return want.startsWith(r.slice(0, -1));
  return r === want;
}

function toolAllowed(tools: string[], tool: string | undefined): boolean {
  // An empty allowlist is an unconstrained grant. A named tool must be in it —
  // otherwise the VG's embedded rego denies and attaching it achieves nothing.
  if (tools.length === 0) return true;
  return tool === undefined || tools.includes(tool);
}

function covers(
  cred: HeldCredential,
  resource: string,
  protocol: string,
  messageType: string,
  tool: string | undefined,
): boolean {
  if (!toolAllowed(cred.tools, tool)) return false;
  return cred.scope.some(
    (s) =>
      protocolMatches(s.protocol, protocol) &&
      messageTypeMatches(s.messageTypes, messageType) &&
      resourceMatches(s.resource, resource),
  );
}

/**
 * The covering set for one outbound message.
 *
 * `recipients` is the message's `to`: the node evaluates one decision per
 * recipient, so a credential covering ANY of them belongs on the wire.
 *
 * An empty result is a legitimate outcome, not an error. Most DIDComm traffic —
 * discovery, trust-ping, problem reports — rides the node's allow rules with no
 * grant at all. Refusing to send on empty would break more than it protects;
 * `onGrantMiss` is how a caller finds out instead.
 */
export function selectFor(
  creds: HeldCredential[],
  msg: { recipients: string[]; typeUri: string; tool?: string },
): VgAttachment[] {
  const { protocol, messageType } = splitTypeUri(msg.typeUri);
  return creds
    .filter((c) =>
      msg.recipients.some((r) => covers(c, r, protocol, messageType, msg.tool)),
    )
    .map((c) => ({
      id: c.id,
      media_type: "application/vc+jwt" as const,
      data: { jws: c.rawJwt },
    }));
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const seg = jwt.split(".")[1];
  if (!seg) return {};
  const pad = "=".repeat((4 - (seg.length % 4)) % 4);
  const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Decode one stored record into a `HeldCredential`, or `null` if it is not a VG. */
export function parseCredential(rec: Record<string, unknown>): HeldCredential | null {
  const rawJwt = (rec.credential_jwt ?? rec.raw_jwt ?? rec.jwt) as string | undefined;
  if (typeof rawJwt !== "string") return null;

  // Claims are at the TOP LEVEL of the payload on this node; the `vc` wrapper is
  // the standard alternative and both are accepted.
  const payload = decodeJwtPayload(rawJwt);
  const vc = ((payload.vc ?? payload) ?? {}) as Record<string, unknown>;
  const cs = (vc.credentialSubject ?? {}) as Record<string, unknown>;
  const scope = Array.isArray(cs.scope) ? (cs.scope as Scope[]) : [];
  // A VRTC has `grantable` instead of `scope` and belongs in the node's control
  // chain, not here. No scope, not a grant.
  if (scope.length === 0) return null;

  const grant = (cs.grant ?? {}) as { tools?: unknown };
  const id = (vc.id ?? rec.credential_id ?? payload.jti) as string | undefined;

  return {
    id: typeof id === "string" ? id : rawJwt.slice(0, 24),
    rawJwt,
    scope,
    tools: Array.isArray(grant.tools) ? (grant.tools as string[]) : [],
  };
}

/**
 * The grants a DID holds, read from the node.
 *
 * Cached for `ttlMs` because a send should not cost a round trip. The TTL is the
 * whole freshness story: a grant minted seconds ago is invisible until it
 * expires, which is why it is short and why `refresh()` exists for a caller that
 * has just been told it was granted something.
 */
export class Wallet {
  private cache = new Map<string, { at: number; creds: HeldCredential[] }>();

  /**
   * `reader` is the SDK's `RestClient`, not `fetch`. That is a repo convention
   * with a reason: the REST client goes through `node:http` and sets the Host
   * header itself, which is what makes `*.localhost` resolve in local
   * development. A `fetch` here works everywhere except the machines this is
   * developed on, and fails there as a network error that names no cause.
   */
  constructor(
    private readonly reader: CredentialReader,
    private readonly ttlMs = 60_000,
  ) {}

  /** Drop the cached grants for `did` (or all), forcing the next send to re-read. */
  refresh(did?: string): void {
    if (did === undefined) this.cache.clear();
    else this.cache.delete(did);
  }

  async heldBy(did: string, now: number = Date.now()): Promise<HeldCredential[]> {
    const hit = this.cache.get(did);
    if (hit && now - hit.at < this.ttlMs) return hit.creds;

    const data = await this.reader.get<unknown>(
      `/api/v1/credentials?holder_did=${encodeURIComponent(did)}`,
    );
    const records = (
      Array.isArray(data) ? data : ((data as { credentials?: unknown[] })?.credentials ?? [])
    ) as Array<Record<string, unknown>>;

    const creds = records
      .map(parseCredential)
      .filter((c): c is HeldCredential => c !== null);

    this.cache.set(did, { at: now, creds });
    return creds;
  }

  /** The attachments for one outbound message, or `[]` if nothing covers it. */
  async attachmentsFor(
    did: string,
    msg: { recipients: string[]; typeUri: string; body?: unknown },
  ): Promise<VgAttachment[]> {
    const creds = await this.heldBy(did);
    return selectFor(creds, {
      recipients: msg.recipients,
      typeUri: msg.typeUri,
      tool: toolNameOf(msg.body),
    });
  }
}
