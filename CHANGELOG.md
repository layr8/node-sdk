# Changelog

All notable changes to `@layr8/sdk`. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

This file starts at 0.2.0. Older versions (0.1.x) are recorded only in git history.

## [0.2.5] - 2026-08-21

### Added

- `identityAttachment(credentialJws)` — a first-class way to attach an
  **identity credential** (a credential about who the sender is, with no
  `credentialSubject.scope`) so it reaches the cloud-node's
  `sender_credentials` policy input, where a grant's `senderCredentials`
  requirement can see it. It builds the attachment; **the caller names the
  credential**. The SDK does not choose: the requirement being satisfied lives
  in the recipient's grant and never reaches the sender, so automatic selection
  could only mean "attach everything the holder has", which is a disclosure
  decision, not a convenience. Throws on anything that is not a compact JWS,
  and on a credential that carries a scope — that is a grant, and attached this
  way it would be routed as one and satisfy nothing.
- `isIdentityAttachment(attachment)`, the same test applied to an attachment
  already on a message.

### Changed

- Caller-supplied attachments still displace the wallet, with one narrowing:
  when they are **all** identity credentials, the wallet's grants are appended
  after them instead. Saying who you are must not stop you saying what you may
  do — under the old rule it did, and the node's denial then read "no grant
  covers this call". Anything else a caller attaches behaves exactly as before.

## [0.2.4] - 2026-08-10

### Changed

- Internal references removed from the shipped package. The comments in
  `wallet.ts` and `space-watch.ts` — and therefore the `.d.ts` files and the
  README inside the published tarball — cited a path on a developer's laptop, a
  link to a private repository, private repo file paths, internal tracker IDs
  and the internal policy engine's rule files. `0.2.3` and earlier carry them on
  npm; this is the first release that does not.

  Nothing technical was lost: every claim the comments made is still there,
  phrased against the system an external reader can actually see. No behaviour,
  exports or test assertions changed.

## [0.2.3] - 2026-08-10

### Added

- `SpaceWatcher` (`src/space-watch.ts`) — a dual-signal poll/diff/notify
  watcher for "does my MCP tool surface still look the same," so consumers
  (the `mcp` broker, and `layr8` hex's `Layr8.SpaceWatcher` on the Elixir
  side) stop each reimplementing the same loop. Watches a wallet (VG/
  credential set) on a 15s default interval and a resource set (Space
  directory MCP Instance cards) on a 60s default interval, independently:
  each signal is reduced to an order-independent signature
  (`orderIndependentSignature`, sorted/deduped/joined) and diffed against its
  own last-accepted value.

  A fetch error never wipes the retained signature — it's logged via the
  optional `onError` callback and retried next poll, so a transient wallet-
  read or directory failure never reads as "everything disappeared." An
  empty resource result debounces: it's only accepted after two consecutive
  empty polls (ported from the broker's `acceptsDiscovery`), since a
  directory answering with nothing is just as likely to be a keepalive blip
  as a real teardown; growing the set, or shrinking it to a still-non-empty
  set, applies immediately either direction. The wallet signal does **not**
  debounce empty — an empty wallet is a real answer, not a blip. The first
  successful poll per signal seeds the baseline silently (no callback) — a
  cold start is not a change. `refreshWallet()`/`refreshResources()` force an
  immediate out-of-cycle check outside the poll interval.

  Every Layr8 SDK implements the same semantics, so a caller sees a change at
  the same latency regardless of which one it is built on.

- `restTimeoutMs` (default 30s, env `LAYR8_REST_TIMEOUT_MS`) — a deadline on
  **every** credential and presentation call, plus a per-call `timeoutMs` on each
  of them. `grantReadTimeoutMs` bounded the grant read and nothing else:
  `signCredential`, `verifyCredential`, `storeCredential`, `listCredentials`,
  `getCredential`, `signPresentation` and `verifyPresentation` still had no
  deadline at all, and `http.request` has none of its own, so a node that
  accepted the connection and went quiet left those promises pending forever —
  neither resolving nor rejecting, and never letting the caller reach the point
  of deciding to retry.

  The deadline is on socket **inactivity**, not total elapsed time, which is what
  lets it catch a silent connection — and also means the node's own signing time
  counts against it, since nothing flows on the wire while it computes. Hence the
  escape hatch: pass `timeoutMs` on the call you know is slow, or `0` to make
  that one call unbounded. `restTimeoutMs: 0` restores the previous behaviour
  everywhere.

### Fixed

- An out-of-range `grantCacheMs`, `grantReadTimeoutMs` or `restTimeoutMs` passed
  in **config** now falls back to the default, as one from the environment
  already did. The range check sat only on the environment branch, so the
  documented bounds were enforced against operators and not against callers —
  and the caller is where a bad value actually comes from:
  `{ restTimeoutMs: Number(process.env.MY_TIMEOUT) }` is `NaN` when the variable
  is unset, and `NaN` passed straight through, failed every comparison
  downstream, and silently left the calls unbounded.

  Two consequences worth naming, both of them the code finally doing what its
  own documentation said: an explicit `grantReadTimeoutMs: 0` now falls back to
  2s instead of disabling the read deadline (zero was already refused from the
  environment, for the reason that a zero deadline aborts every read before it
  starts), and an explicit `grantCacheMs: NaN` now falls back to 60s instead of
  re-reading the credentials on every message. Defaults and bounds are unchanged.

## [0.2.2] - 2026-08-07

### Added

- **Verifiable Grants are attached to outbound messages** — automatically, on
  every send path (`send`, `request`, and a handler's reply). The cloud-node
  requires a grant for anything its policy does not allow outright, and nothing
  in this SDK attached one: there was no enforcement on outgoing requests because
  there was no *mechanism*. An agent connecting directly, on any protocol other
  than MCP through the broker, sent nothing and was denied with a message that
  names the grant it could not find — which reads as "your grant is
  misconfigured" when the truth is "no credential was ever put on the wire".

  On by default. Opting in would have left every existing agent in exactly that
  state. Turn it off with `attachGrants: false` / `LAYR8_ATTACH_GRANTS=false` and
  compose `attachments` yourself; attachments you supply are never displaced.

- `onGrantMiss` — called when the node denies a message that went out with
  nothing attached, carrying the node's denial code. Also called immediately,
  with `error`, when the grants could not be read at all, and with `capped` when
  more credentials covered a message than fit on one frame. The sender is the
  only party that can tell any of those apart from a misconfigured grant.

  Its argument is the exported `GrantMissInfo`.

- `grantReadTimeoutMs` (default 2s, env `LAYR8_GRANT_READ_TIMEOUT_MS`) — deadline
  on the credential read that precedes a send. `http.request` has no default
  timeout, and this read runs inside the per-channel write chain that keeps
  writes in call order: a node that accepts the connection and never answers
  would otherwise stall every later send on that channel, including sends
  carrying their own attachments that never consult the wallet. A timeout is
  treated as a read failure — the message goes out unattached, `onGrantMiss`
  says so.

- `client.refreshGrants(did?)` — drop the cached grants for a DID, for an agent
  that has just been told it was granted something and should not wait out
  `grantCacheMs`.

- `grantCacheMs` (default 60s, env `LAYR8_GRANT_CACHE_MS`) — how long held grants
  are cached before re-reading.

### Fixed

- Outbound writes keep **call order** even though attaching now puts an `await`
  in front of every one of them. `send(A)` then `send(B)`, with A's credential
  read the slower, previously arrived as `[B, A]`.

- A grant whose scope names a resource by **segment prefix** is now attached.
  The node's policy matches `tables` against `tables/customers` (and not
  against `tables_archive`); this side compared for equality only, so it withheld
  a credential the policy would have honoured — the expensive direction, because
  the failure is a silent denial.

- The cap on attachments per message no longer discards by read order alone. The
  tool named in the message is used to RANK the covering set (never to filter
  it), so a holder with per-tool grants keeps the one that authorises this call
  instead of whichever sixteen the node happened to return first. When the cap
  does bite, `onGrantMiss` says so.

- A denial is still reported after a burst of traffic. The map of messages sent
  unattached was evicted by count, and every message needing no grant took a
  slot — 64 trust-pings between a message and its denial and `onGrantMiss` never
  fired. It is evicted by age now.

- `Config.onGrantMiss` declares `denialCode`. The field was passed at runtime and
  used by the README's own example, but the public type omitted it, so that
  example did not compile. Both declarations are now one exported type, and
  `npm run lint` type-checks `tests/` (`tsconfig.tests.json`) — the gap that let
  the two drift.

## [0.2.1] - 2026-07-21

### Added

- **MCP (Model Context Protocol) over DIDComm** — `Layr8Client.mcp(base?)`. A
  growing set of Layr8 services (Loom is the first) expose an MCP surface as
  DIDComm request/reply: a request of type `${base}/<method>` carrying a
  JSON-RPC 2.0 body, answered by a `${base}/<method>-result` message. The reply
  echoes the request `thread_id`, so `request()` already correlates it; `mcp()`
  removes the boilerplate. Call it BEFORE `connect()` (like `handle()`) — it
  registers the protocol subscription the node needs to deliver `${base}/*`
  replies. `mcp().peer(did)` returns an `McpPeer` with `.call(method, params)`
  (returns the JSON-RPC `result`, throws `McpError` on a JSON-RPC `error`) plus
  `.callTool(name, args)`, `.listTools()`, and `.initialize()` conveniences.
  Exposes `McpBinding`, `McpPeer`, `McpError`, and `DEFAULT_MCP_BASE`.
  Previously every consumer hand-rolled a `send` + result-type-handler +
  body-id-correlation client to talk to these services; now it is two lines.

## [0.2.0] - 2026-05-25

### Added

- **Multi-DID hosting on one WebSocket** (`#35`). `Layr8Client.joinDid(did, opts)` opens an additional Phoenix channel for `did` over the existing WS and returns a `DidHandle` with per-DID `.send` / `.request` / `.sendAck`. `leaveDid(did)` tears it down. `opts.handlers` accepts a per-DID handler map (or `{ fn, manualAck }` entries) that fires first; the client-global registry registered via `handle(...)` is the fallback. Cloud-node needs zero changes — Phoenix natively supports N joins per socket via `channel("plugins:*", Channel)`.
- **`Connection` + `Channel` split**, formerly the `PhoenixChannel` monolith. `Connection` owns the WebSocket, the global ref counter, the pending-reply table (shared across topics), the Phoenix-heartbeat watchdog, the WS-level ping/pong, the reconnect loop, and the topic → `Channel` registry. `Channel` owns one joined `plugins:<did>` topic, joinRef, `phx_join` handshake, and per-topic send/sendFireAndForget/sendAck. Both are exported.
- `joinDid` auto-subscribes to the problem-report protocol, mirroring the same auto-add already done by `connect()` for the primary DID.

### Changed

- Reconnect rejoins every registered Channel after the WebSocket is re-dialed. **Single-DID** rejoin failure propagates to the backoff loop (matches pre-refactor `PhoenixChannel` behaviour so ember and other single-DID consumers don't end up in a silently-broken "reconnected but `Channel.send` throws" state). **Multi-DID** rejoin failures are isolated per Channel — one Instance's transient join failure does not stall the others.
- `Channel.send` / `sendFireAndForget` now also throw `NotConnectedError` when the Channel's most recent rejoin failed (`joined = false`), avoiding silent drops on the wire when the cloud-node has no subscription for the topic.

### Deprecated

- `PhoenixChannel` is retained as a thin facade over `Connection` + `Channel` so existing single-DID consumers and the existing `tests/channel.test.ts` integration tests continue to work unchanged. Slated for removal in a follow-up once consumers and tests are migrated to `Connection` / `Channel` directly.

### Fixed

- `Connection.dialImpl` now closes the previous WebSocket at the start of every dial attempt. Previously, a failed rejoin in the reconnect loop would leak the prior WebSocket — server-side it stayed open, and tests that call `server.close()` would hang waiting for clients to disconnect.

### Tests

- 16 new tests under `tests/multi-did.test.ts` covering `joinDid` lifecycle (before connect, duplicate DID, primary-DID rejection, `leaveDid`, close-tears-down-all), inbound routing by topic (per-DID first, fallback to client-global, override priority, unrelated topic drops), `DidHandle.send` (writes to its own topic, stamps `from`), and three reconnect scenarios (rejoin every Channel after WS drops, isolated rejoin failure in multi-DID, single-DID rejoin failure retries the backoff loop).
- 3 small test-bug fixes in `tests/client.test.ts` where the wrong topic literal (`plugin:lobby`, singular and incorrect) was masked by the old monolith's lack of topic routing. Updated to `plugins:<agentDid>` to match production.

[0.2.5]: https://github.com/layr8/node-sdk/releases/tag/v0.2.5
[0.2.4]: https://github.com/layr8/node-sdk/releases/tag/v0.2.4
[0.2.3]: https://github.com/layr8/node-sdk/releases/tag/v0.2.3
[0.2.2]: https://github.com/layr8/node-sdk/releases/tag/v0.2.2
[0.2.1]: https://github.com/layr8/node-sdk/releases/tag/v0.2.1
[0.2.0]: https://github.com/layr8/node-sdk/releases/tag/v0.2.0
