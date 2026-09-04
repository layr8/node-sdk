/**
 * Store-and-forward for an agent that is not always connected, against a
 * DIDComm mediator (`layr8/mediator`): coordinate-mediation/3.0 enrolment,
 * messagepickup/3.0 collection, and the cloud-node's mediator declaration.
 *
 * The cloud-node deposits any message that arrives while this agent's plugin
 * is offline with the mediator the agent has **declared** on its node
 * (`PUT /api/v1/dids/:did/mediator`, cloud-node ADR 0005). What the mediator
 * holds is the original ciphertext, so collecting it means posting each
 * attachment back to this agent's own node at `/didcomm`, where it is
 * unpacked, sender-bound and authorized exactly like a first arrival, and
 * then delivered to this client's handlers. Nothing here ever decrypts.
 *
 * Zero-config use — give the client a mediator and it does the rest on every
 * (re)connect, in the background:
 *
 *   new Layr8Client(logErrors(), { mediator: "did:web:node.example:agents:mediator" })
 *
 * (or `LAYR8_MEDIATOR_DID`). Steps: `enroll` → `declare` → `pickup` → `live`.
 * Every step is also callable by hand; none throws for a remote refusal —
 * they return `{ ok: false, ... }` results — only programming errors throw.
 */

import type { Layr8Client } from "./client.js";
import type { Attachment, Message } from "./message.js";
import type { HandlerFn } from "./handler.js";
import { postDidcomm } from "./rest.js";
import { ProblemReportError } from "./errors.js";

const CM = "https://didcomm.org/coordinate-mediation/3.0/";
const PICKUP = "https://didcomm.org/messagepickup/3.0/";

/** The message type a mediated client handles for live pushes. */
export const DELIVERY_TYPE = `${PICKUP}delivery`;

/** Protocol bases a mediated client subscribes to. */
export const MEDIATION_PROTOCOLS = [CM.slice(0, -1), PICKUP.slice(0, -1)];

const DEFAULT_LIMIT = 10;
const MAX_ROUNDS = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

/** A failed step: `{ ok: false, error }`; `error` is a string or a ProblemReportError. */
export type MediationFailure = { ok: false; error: string | ProblemReportError };

export interface MediationOptions {
  /** Deadline per request to the mediator (default 20 s). */
  timeoutMs?: number;
}

export interface EnrollOptions extends MediationOptions {
  /** Extra DIDs to register as routing keys besides the agent's own. */
  recipients?: string[];
}

export interface PickupOptions extends MediationOptions {
  /** Messages per `delivery-request` (default 10). */
  limit?: number;
  /** Where ciphertext is re-injected (default `client.didcommUrl`). */
  didcommUrl?: string;
}

export interface BootstrapOptions extends EnrollOptions, PickupOptions {
  /** Turn live delivery on after collecting (default true). */
  live?: boolean;
}

export type EnrollResult =
  | { ok: true; routingDid: string[]; updated: Array<Record<string, unknown>> }
  | MediationFailure;
export type PickupResult = { ok: true; collected: number } | MediationFailure;
export type StatusResult = { ok: true; status: Record<string, unknown> } | MediationFailure;
export type SimpleResult = { ok: true } | MediationFailure;

function fail(error: unknown): MediationFailure {
  if (error instanceof ProblemReportError) return { ok: false, error };
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function request(
  client: Layr8Client,
  mediator: string,
  type: string,
  body: unknown,
  opts?: MediationOptions,
): Promise<Message> {
  return client.request(
    { type, to: [mediator], body },
    { signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
  );
}

/** @internal Whether the agent's own DID came back registered (success or no_change). */
export function ownRegistered(updated: unknown, own: string): boolean {
  if (!Array.isArray(updated)) return false;
  const mine = updated.find(
    (u) => u && typeof u === "object" && (u as Record<string, unknown>).recipient_did === own,
  ) as Record<string, unknown> | undefined;
  return mine?.result === "success" || mine?.result === "no_change";
}

/** @internal The attachment's ciphertext (base64url `data.base64`), or null. */
export function ciphertext(att: Attachment): Buffer | null {
  const b64 = att.data?.base64;
  if (typeof b64 !== "string" || b64 === "") return null;
  try {
    return Buffer.from(b64, "base64url");
  } catch {
    return null;
  }
}

/** @internal */
export function mediatorPath(did: string): string {
  return `/api/v1/dids/${did}/mediator`;
}

/**
 * Requests mediation and registers this agent's DID (plus `opts.recipients`)
 * with `mediator`. Idempotent: a second call re-receives the grant and gets
 * `no_change` on the registrations.
 */
export async function enroll(
  client: Layr8Client,
  mediator: string,
  opts?: EnrollOptions,
): Promise<EnrollResult> {
  try {
    const grant = await request(client, mediator, `${CM}mediate-request`, {}, opts);
    if (grant.type === `${CM}mediate-deny`) return { ok: false, error: "mediate_denied" };
    if (grant.type !== `${CM}mediate-grant`) {
      return { ok: false, error: `unexpected reply ${grant.type}` };
    }
    const routing = (grant.body as { routing_did?: string | string[] })?.routing_did;
    const routingDid = Array.isArray(routing) ? routing : routing ? [routing] : [];

    const own = client.did;
    const recipients = Array.from(new Set([own, ...(opts?.recipients ?? [])]));
    const updates = recipients.map((d) => ({ recipient_did: d, action: "add" }));
    const resp = await request(client, mediator, `${CM}recipient-update`, { updates }, opts);
    if (resp.type !== `${CM}recipient-update-response`) {
      return { ok: false, error: `unexpected reply ${resp.type}` };
    }
    const updated = ((resp.body as { updated?: unknown })?.updated ?? []) as Array<
      Record<string, unknown>
    >;
    if (!ownRegistered(updated, own)) {
      return { ok: false, error: `recipient-update did not register ${own}: ${JSON.stringify(updated)}` };
    }
    return { ok: true, routingDid, updated };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Declares `mediator` as this agent's mediator on its own cloud-node, so the
 * node deposits messages there while the agent is offline and the DID
 * document advertises it as `routingKeys`.
 */
export async function declare(client: Layr8Client, mediator: string): Promise<SimpleResult> {
  try {
    await client._rest.put(mediatorPath(client.did), { routing_did: mediator });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Removes this agent's mediator declaration on its node. */
export async function undeclare(client: Layr8Client): Promise<SimpleResult> {
  try {
    await client._rest.delete(mediatorPath(client.did));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Posts each attachment's ciphertext to this agent's node at `/didcomm`.
 * Returns the ids that went in and the ids that did not (those are never
 * acknowledged, so the mediator keeps them).
 */
export async function reinject(
  client: Layr8Client,
  attachments: Attachment[],
  opts?: PickupOptions,
): Promise<{ ok: string[]; failed: string[] }> {
  const url = opts?.didcommUrl ?? client.didcommUrl;
  const ok: string[] = [];
  const failed: string[] = [];
  for (const att of attachments) {
    const id = att.id ?? "";
    const jwe = ciphertext(att);
    if (!jwe) {
      failed.push(id);
      continue;
    }
    try {
      await postDidcomm(url, jwe, opts?.timeoutMs);
      ok.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { ok, failed };
}

/**
 * Re-injects `attachments` and acknowledges the ones that went in.
 * `complete` is false when something was left with the mediator.
 */
export async function collect(
  client: Layr8Client,
  mediator: string,
  attachments: Attachment[],
  opts?: PickupOptions,
): Promise<{ collected: number; complete: boolean }> {
  const { ok, failed } = await reinject(client, attachments, opts);
  if (ok.length > 0) {
    try {
      await request(client, mediator, `${PICKUP}messages-received`, { message_id_list: ok }, opts);
    } catch {
      // The messages are in; a lost ack only means a redelivery next time.
    }
  }
  return { collected: ok.length, complete: failed.length === 0 };
}

/**
 * Drains the mediator: repeats `delivery-request` until a `status` reply,
 * re-injecting and acknowledging as it goes. Stops early, without losing
 * anything, if a re-injection fails.
 */
export async function pickup(
  client: Layr8Client,
  mediator: string,
  opts?: PickupOptions,
): Promise<PickupResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  let collected = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await request(client, mediator, `${PICKUP}delivery-request`, { limit }, opts);
      if (reply.type === `${PICKUP}status`) break;
      if (reply.type !== DELIVERY_TYPE) return { ok: false, error: `unexpected reply ${reply.type}` };
      const atts = reply.attachments ?? [];
      if (atts.length === 0) break;
      const r = await collect(client, mediator, atts, opts);
      collected += r.collected;
      if (!r.complete) break;
    }
    return { ok: true, collected };
  } catch (err) {
    return fail(err);
  }
}

/** Turns live delivery on or off; returns the mediator's `status` body. */
export async function live(
  client: Layr8Client,
  mediator: string,
  flag: boolean,
  opts?: MediationOptions,
): Promise<StatusResult> {
  try {
    const reply = await request(client, mediator, `${PICKUP}live-delivery-change`, { live_delivery: flag }, opts);
    if (reply.type !== `${PICKUP}status`) return { ok: false, error: `unexpected reply ${reply.type}` };
    return { ok: true, status: (reply.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    return fail(err);
  }
}

/** Asks the mediator how many messages are waiting. */
export async function status(
  client: Layr8Client,
  mediator: string,
  opts?: MediationOptions,
): Promise<StatusResult> {
  try {
    const reply = await request(client, mediator, `${PICKUP}status-request`, {}, opts);
    if (reply.type !== `${PICKUP}status`) return { ok: false, error: `unexpected reply ${reply.type}` };
    return { ok: true, status: (reply.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The handler a mediated client registers for the mediator's live `delivery`
 * pushes: re-inject and acknowledge, no reply.
 * @internal
 */
export function deliveryHandler(client: Layr8Client): HandlerFn {
  return async (msg: Message) => {
    await collect(client, msg.from, msg.attachments ?? []);
    return null;
  };
}

/**
 * `enroll` → `declare` → `pickup` → `live` (when `opts.live !== false`),
 * stopping at the first failure. Never throws.
 */
export async function bootstrap(
  client: Layr8Client,
  mediator: string,
  opts?: BootstrapOptions,
): Promise<{ ok: true; collected: number } | { ok: false; step: string; error: MediationFailure["error"] }> {
  const e = await enroll(client, mediator, opts);
  if (!e.ok) return { ok: false, step: "enroll", error: e.error };
  const d = await declare(client, mediator);
  if (!d.ok) return { ok: false, step: "declare", error: d.error };
  const p = await pickup(client, mediator, opts);
  if (!p.ok) return { ok: false, step: "pickup", error: p.error };
  if (opts?.live !== false) {
    const l = await live(client, mediator, true, opts);
    if (!l.ok) return { ok: false, step: "live", error: l.error };
  }
  return { ok: true, collected: p.collected };
}
