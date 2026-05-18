# Node SDK Principles

## Public Repository

This is a public repository. Every commit is visible to the world.

### Before every commit, verify:

- **No real API keys, passwords, or tokens.** Test keys must be obviously fake (e.g., contain `testkey` in the string).
- **No internal infrastructure references.** No cloud account IDs, cluster names, or internal domain names. Only `*.localhost` and `example.com` are acceptable.
- **No internal documentation links.** No references to private repos, internal wikis, or private channels.
- **No customer data or PII.**

### Acceptable

- Local-dev test keys with obvious patterns (e.g., `alice_abcd1234_testkeyalicetestkeyali24`)
- `*.localhost` URLs for local development
- `did:web:*.localhost:*` test DIDs
- Unit test sentinel values like `"test-api-key"`

### Not acceptable

- Keys that follow production format without obvious test markers
- Internal service URLs (`.internal`, `.corp`, `.svc.cluster.local`)
- `.env` files with real values (`.env.example` with placeholders is fine)

## Testing

- Run `npx vitest run` before every commit
- Integration tests require a local dev environment with two cloud-nodes (alice-test, bob-test)

## Cloud-Node Protocol Requirement

The cloud-node **requires at least one protocol** in `payload_types` when joining a Phoenix channel. Clients that join with an empty protocol list get rejected with `e.join.plugin.protocol.missing`.

- The Node SDK auto-adds the problem report protocol (`https://didcomm.org/report-problem/2.0`) to the join payload, so handler-only clients always have at least one protocol.
- Sender-only clients that don't register handlers still get the problem report protocol auto-added, avoiding the empty-protocols issue.
- If a `protocols` config option is added in the future, it should merge with (not replace) handler-derived protocols, matching the Python SDK pattern.

## Conventions

- ESM-only (`"type": "module"`)
- REST client uses `node:http`/`node:https` (not `fetch`) for proper `*.localhost` resolution via Host header
- Options objects for API methods (e.g., `{ nonce, verifierDid, format }`)
