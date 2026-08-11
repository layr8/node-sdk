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
 * That misreading is the expensive part: the denial names a grant, so it sends
 * you to check a grant that is fine. The sender is the only party that knows it
 * attached nothing, so the sender is the only one that can say so — see
 * `onGrantMiss`.
 *
 * ## The attachment shape is load-bearing
 *
 * `media_type` is the ONLY thing the node's credential extractor filters on: it
 * keeps attachments whose media type is exactly `"application/vc+jwt"` and drops
 * every other one SILENTLY, before looking at the data at all. A VP
 * (`application/vp+jwt`) is discarded on that rule, and the denial that follows
 * is byte-for-byte the one you get for attaching nothing — which is why the
 * mistake is expensive to find.
 *
 * `data.jws` is the primary place the JWS is read from, and what this SDK
 * writes. `data.base64` is NOT dropped: the extractor falls back to it and
 * base64url-decodes it. `data.jws` is still the right choice — it is the field
 * the extractor reaches for first and the one the whole ecosystem writes — but
 * the reason is "primary path", not "the alternative is discarded". A confident
 * wrong reason costs more than no comment: it sends the next reader looking in
 * the wrong place for why their attachment vanished.
 *
 ## Over-attaching is free; under-attaching is not
 *
 * The node's policy allows on the FIRST passing grant and ignores the rest, so
 * an extra credential on the wire costs nothing. A credential withheld costs a
 * working call, and the failure is invisible — it presents as the same "no grant
 * covers this call" this file exists to end.
 *
 * That asymmetry decides every judgement call here. An earlier version filtered
 * on the grant's `credentialSubject.grant.tools` allowlist, reasoning that its
 * embedded rego would deny anyway. It was the one rule stricter than the policy,
 * and the only place the change carried downside risk: `toolNameOf` read
 * `body.params.name` protocol-blind, so ANY message with a JSON-RPC-shaped body
 * — which is most of them — could drop a grant the node would have honoured. No
 * policy reads `grant.tools` at all; the node evaluates
 * `credentialSubject.constraints.rego`, keyed by grant id, which this side
 * cannot reproduce and should not try to.
 *
 * ## Selection mirrors the policy, and deliberately errs wide
 *
 * `covers()` mirrors the node's authorization policy: some scope entry must
 * match the protocol, the message type and the resource. What this does NOT do is
 * decide anything the PDP decides — revocation and validity windows are checked
 * there, against sources this side cannot see. Attaching a revoked or expired
 * grant costs one denial; withholding one because a local cache thought it was
 * dead costs a working call, and the failure is silent. The wallet's job is to
 * put on the wire everything that plausibly applies.
 */

import { DEFAULT_GRANT_READ_TIMEOUT_MS } from "./config.js";

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
  /**
   * The node's `valid_until`, as epoch ms, when it sent one.
   *
   * NOT used to withhold anything — validity is the PDP's decision, made against
   * a clock this side cannot see, and a skewed local clock dropping a live grant
   * fails silently. It only breaks ties under `MAX_ATTACHED`, so a live grant
   * never loses its slot to one that has certainly lapsed.
   */
  expiresAt?: number;
}

/**
 * The most credentials put on one message.
 *
 * Over-attaching is free at the policy, but not on the wire: a holder with
 * per-tool grants can hold dozens, each a 1-2KB JWT, on every message. The cap
 * is far above any real holding; when it bites, the entries kept are the most
 * likely to matter — see `selectFor` — and the caller is TOLD, because a
 * credential dropped here produces the same indistinguishable denial as one
 * never held.
 */
export const MAX_ATTACHED = 16;

/** Reads a JSON path from the node. `RestClient` is the SDK's, deliberately. */
export interface CredentialReader {
  get<T>(path: string, opts?: { timeoutMs?: number }): Promise<T>;
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

// ── policy mirror ──

function protocolMatches(p: string | undefined, want: string): boolean {
  return p === "*" || p === want;
}

function messageTypeMatches(types: string[] | undefined, want: string): boolean {
  return Array.isArray(types) && (types.includes("*") || types.includes(want));
}

/**
 * The three ways a scope's `resource` can cover a message's, in the order the
 * node's policy states them:
 *
 *   1. equal;
 *   2. `foo/*` covers anything under `foo/` — note the rego strips only the
 *      `*`, so the trailing slash is part of the prefix and `foo/*` does not
 *      cover `foobar`;
 *   3. a bare `foo` covers `foo/bar` — a SEGMENT prefix, requiring the next
 *      character to be `/` so `tables` covers `tables/customers` but not
 *      `tables_archive`.
 *
 * Clause 3 was missing here, and its absence pointed the wrong way: this side
 * withheld a grant the policy would have honoured, which is the failure that
 * costs a working call and shows up as "no grant covers this call". It bites
 * nothing today only because the PEP sets the message resource to the recipient
 * DID and a `did:web` contains no `/` — a premise nothing in this file states
 * and nothing in this file controls.
 */
function resourceMatches(r: string | undefined, want: string): boolean {
  if (r == null || r === "" || r === "*") return true;
  if (r.endsWith("/*")) return want.startsWith(r.slice(0, -1));
  if (r === want) return true;
  return want.startsWith(r) && want.charAt(r.length) === "/";
}

function covers(
  cred: HeldCredential,
  resource: string,
  protocol: string,
  messageType: string,
): boolean {
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
  msg: { recipients: string[]; typeUri: string; tool?: string; now?: number },
  /**
   * Told when the cap left credentials off. Silence here is the same class of
   * failure this file exists to end: the holder is the only party that knows a
   * covering credential never reached the wire.
   */
  onCapped?: (info: { covering: number; attached: number }) => void,
): VgAttachment[] {
  const { protocol, messageType } = splitTypeUri(msg.typeUri);
  const now = msg.now ?? Date.now();

  const covering = creds.filter((c) =>
    msg.recipients.some((r) => covers(c, r, protocol, messageType)),
  );

  // Ordering only matters when the cap bites. It decides which credentials are
  // LEFT OFF, so it ranks by how likely each one is to have been the one that
  // mattered — it is not a filter, and nothing here withholds anything the cap
  // has room for.
  //
  // Live beats lapsed by more than everything else combined: a certainly-expired
  // grant cannot be the one that would have worked.
  //
  // Then the tool. `tools` was carried into this function and never read — the
  // parameter was dead, so under the cap the choice among per-tool grants came
  // down to the node's row order, and the comment on MAX_ATTACHED describes
  // exactly the holding where that bites: dozens of grants identical in
  // protocol, message type and resource, differing only in which tool they name.
  // Thirty of those and the one that authorises this call sitting twentieth
  // meant a silent drop and an `e.m.authz.denied` with no way to see why.
  //
  // Naming this tool ranks first, naming no tool at all (unrestricted) second,
  // naming only OTHER tools last — last, not excluded: `grant.tools` is not a
  // policy input anywhere: the node evaluates the grant's own
  // `credentialSubject.constraints.rego`, keyed by grant id, and an earlier
  // version that filtered on it dropped grants the node would have honoured.
  const toolRank = (c: HeldCredential): number => {
    if (c.tools.length === 0) return 1;
    return msg.tool !== undefined && c.tools.includes(msg.tool) ? 0 : 2;
  };

  // Named resource before wildcard, as the finest-grained tiebreak.
  const rank = (c: HeldCredential): number =>
    (c.expiresAt !== undefined && c.expiresAt <= now ? 8 : 0) +
    toolRank(c) * 2 +
    (c.scope.some((s) => s.resource && s.resource !== "*" && !s.resource.endsWith("/*")) ? 0 : 1);

  const chosen = covering
    .map((c, i) => ({ c, i }))
    // Index as the tiebreak: a stable order, so the same message does not carry
    // a different set on each send.
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, MAX_ATTACHED);

  if (chosen.length < covering.length) {
    onCapped?.({ covering: covering.length, attached: chosen.length });
  }

  return chosen.map(({ c }) => ({
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
  // A compact JWS has exactly three segments. Anything else cannot be verified
  // by the node, so putting it on the wire only costs a denial that names the
  // wrong problem.
  const parts = rawJwt.split(".");
  if (parts.length !== 3 || !parts[2]) return null;

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
  // `id` is what the REST contract calls it; `credential_id` is the column name,
  // accepted because the two have been confused at this boundary before.
  const id = (vc.id ?? payload.jti ?? rec.id ?? rec.credential_id) as string | undefined;

  const validUntil = (rec.valid_until ?? rec.validUntil ?? vc.validUntil) as string | undefined;
  const expiresAt = typeof validUntil === "string" ? Date.parse(validUntil) : NaN;

  return {
    // The SIGNATURE segment as the fallback, not the head of the JWT: every
    // credential from one issuer shares a header, so `rawJwt.slice(0, 24)` gave
    // them all the SAME attachment id — and a frame carrying two attachments
    // with one id is a frame whose second attachment may not survive.
    id: typeof id === "string" && id !== "" ? id : `urn:jws:${parts[2].slice(0, 32)}`,
    rawJwt,
    scope,
    tools: Array.isArray(grant.tools) ? (grant.tools as string[]) : [],
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

/** A rejected promise that is safe to leave unread. See `heldBy`. */
function rejected(err: unknown): Promise<never> {
  const p = Promise.reject(err);
  p.catch(() => {});
  return p;
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
  // The PROMISE is cached, not the result. Caching the result leaves a window
  // between "cache missed" and "cache written" that every concurrent send falls
  // into: measured, ten sends at cold start made ten identical HTTP requests.
  //
  // A failure is cached too, briefly. Only caching successes meant an agent
  // whose API key cannot read credentials paid a full failing round trip on
  // EVERY outbound message, forever — turning a config mistake into a permanent
  // latency tax. Short, because the fix for that mistake should take effect
  // without a restart.
  private cache = new Map<string, { at: number; creds: Promise<HeldCredential[]> }>();

  /**
   * `reader` is the SDK's `RestClient`, not `fetch`. That is a repo convention
   * with a reason: the REST client goes through `node:http` and sets the Host
   * header itself, which is what makes `*.localhost` resolve in local
   * development. A `fetch` here works everywhere except the machines this is
   * developed on, and fails there as a network error that names no cause.
   */
  /**
   * How long a FAILED read is remembered. Short, because the fix for whatever
   * broke it should take effect without a restart — and never longer than a
   * success is cached, or lowering `grantCacheMs` to see a new grant sooner
   * would leave a stale failure outliving it.
   *
   * Never shorter than the read deadline either. The entry is stamped with the
   * time the read STARTED, so a failure TTL at or below the deadline is already
   * lapsed the moment a timeout records it — and a hung node would then cost
   * every send the full deadline instead of one send per window, with the write
   * chain making those stalls consecutive.
   */
  private readonly failureTtlMs: number;

  constructor(
    private readonly reader: CredentialReader,
    private readonly ttlMs = 60_000,
    failureTtlMs?: number,
    /** Deadline on one read — see `Config.grantReadTimeoutMs`. */
    private readonly readTimeoutMs = DEFAULT_GRANT_READ_TIMEOUT_MS,
  ) {
    this.failureTtlMs = failureTtlMs ?? Math.min(ttlMs, Math.max(5_000, readTimeoutMs));
  }

  /** Drop the cached grants for `did` (or all), forcing the next send to re-read. */
  refresh(did?: string): void {
    if (did === undefined) this.cache.clear();
    else this.cache.delete(did);
  }

  async heldBy(did: string, now: number = Date.now()): Promise<HeldCredential[]> {
    const hit = this.cache.get(did);
    if (hit && now - hit.at < this.ttlMs) return hit.creds;

    const inflight = this.read(did).catch((err: unknown) => {
      // Keep the rejection cached for `failureTtlMs`, then let it lapse.
      //
      // EVERY rejected promise stored here gets a no-op `catch` of its own. A
      // cached rejection nobody happens to read is an unhandled rejection, and
      // Node terminates the process on those by default — so a node that
      // briefly cannot serve credentials would take the agent down with it.
      // Measured: one failing read left 26 unhandled rejections across the
      // suite and made an unrelated timing test fail intermittently.
      this.cache.set(did, { at: now - this.ttlMs + this.failureTtlMs, creds: rejected(err) });
      throw err;
    });
    inflight.catch(() => {});
    this.cache.set(did, { at: now, creds: inflight });
    return inflight;
  }

  private async read(did: string): Promise<HeldCredential[]> {
    // The deadline is the reason this cannot hang the channel it runs on — see
    // `Config.grantReadTimeoutMs`. It belongs HERE rather than as a race around
    // the await in the caller: only the request itself can also destroy the
    // socket, and a race would leave the connection open and this promise parked
    // in the cache, pending, for every send until the TTL lapsed.
    const data = await this.reader.get<unknown>(
      `/api/v1/credentials?holder_did=${encodeURIComponent(did)}`,
      { timeoutMs: this.readTimeoutMs },
    );
    const records = (
      Array.isArray(data) ? data : ((data as { credentials?: unknown[] })?.credentials ?? [])
    ) as Array<Record<string, unknown>>;

    const creds = records
      .map(parseCredential)
      .filter((c): c is HeldCredential => c !== null);

    return creds;
  }

  /** The attachments for one outbound message, or `[]` if nothing covers it. */
  async attachmentsFor(
    did: string,
    msg: { recipients: string[]; typeUri: string; body?: unknown },
    onCapped?: (info: { covering: number; attached: number }) => void,
  ): Promise<VgAttachment[]> {
    const creds = await this.heldBy(did);
    return selectFor(
      creds,
      {
        recipients: msg.recipients,
        typeUri: msg.typeUri,
        tool: toolNameOf(msg.body),
      },
      onCapped,
    );
  }
}
