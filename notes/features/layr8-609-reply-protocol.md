# LAYR8-609: Reply Protocol, Wildcard Binding, Capability Negotiation

## Summary

Major version bump. The cloud node (LAYR8-580) added a dispatch protocol.
The SDK needs to support:
- Capability negotiation on join
- `dispatch_reply` event after each message
- Wildcard binding via `handleAll`
- `PASS` sentinel
- Remove ack (replaced by dispatch_reply)

## Spec

### 1. Capability negotiation
- Send `reply_protocol: true` in join params (channel.ts)
- Parse `capabilities` array from join reply
- If `reply_protocol/1` present → new mode
- If absent → legacy mode (backwards compat with old server)

### 2. dispatch_reply
- After handler invocation, send `dispatch_reply` event:
  - Handler returns Message → `{status: "handled"}` + send reply message
  - Handler returns null/undefined → `{status: "handled"}`
  - Handler returns PASS → `{status: "pass"}`
  - Handler throws → `{status: "error", code: err.name, message: err.message}`
- No handler + no catch-all → `{status: "pass"}`
- Send via `sendFireAndForget`

### 3. handleAll
- `client.handleAll(fn)` — catch-all handler
- Adds `"*"` to payload_types in join
- Priority: specific handler > catch-all > auto-pass

### 4. Remove ack
- Remove `sendAck` from PhoenixChannel public API
- Remove ack-related code from client

### 5. PASS sentinel
- `export const PASS: unique symbol` (or sentinel object)
- Handler returns PASS to signal "I don't handle this"

## Design decisions

- Use a unique symbol for PASS (type-safe, can't collide)
- Legacy mode: keep existing ack behavior for old servers
- New mode: no ack, use dispatch_reply instead
