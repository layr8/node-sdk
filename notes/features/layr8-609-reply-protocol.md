# LAYR8-609: Reply Protocol, Wildcard Binding, Capability Negotiation

## Summary

Major version bump. The cloud node (LAYR8-580) added a dispatch protocol.
The SDK supports:
- Capability negotiation on join
- `dispatch_reply` event after each message
- Wildcard binding via `handleAll`
- `PASS` sentinel
- Legacy ack mode for old servers

## Key design decisions

- `handleAll` replaces `handleDefault` — adds "*" to payload_types, enabling
  the cloud-node to route any message type to this agent
- PASS is a unique symbol (type-safe, can't collide with Message)
- Legacy mode: when server omits `reply_protocol/1` capability, ack-based
  delivery is preserved (backwards compat)
- `sendAck` kept as internal method for legacy mode (PhoenixChannel is not
  part of the public API)
