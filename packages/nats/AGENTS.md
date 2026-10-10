# Agent Guidelines for @effect-messaging/nats

## Purpose

An Effect-native implementation of Core NATS, JetStream and Node/WebSocket
transports. Read the root guidelines and `node_modules/effect/AGENTS.md` before
writing Effect code. The compatibility baseline is nats.js v3.4.0; see
`PARITY.md` and its upstream test inventory before changing protocol behavior.

**Key modules:**

- `NATSConnection` - Core NATS connection (publish/subscribe/request)
- `JetStreamClient` - JetStream consumer and publisher
- `JetStreamConsumerAPI` - Consumer management API
- `JetStreamStreamAPI` - Stream management API
- `JetStreamDirectStreamAPI` - Direct stream API for low-latency reads
- `JetStreamManager` - High-level stream and consumer management
- `JetStreamStoredMessage` - Native stored message with Effect operations
- `JetStreamLister` - Schema-validated paginated streams
- `NATSQueuedIterator` - Queue-backed scoped message streams
- `NATSSubscription` - Subscription handling
- `NATSMessage` - Message utilities
- `NATSError` - Tagged errors

## Architecture

- `internal/protocol.ts` owns incremental binary framing and command encoding
- `internal/client.ts` owns the logical connection and replaceable socket sessions
- `NATSNodeConnection` adapts TCP/TLS to Effect Socket and owns certificate loading
- `NATSOptions`, `NATSHeaders`, `NATSAuth` and `JetStreamTypes` own public types
- JetStream API boundaries decode responses through Effect Schema
- Use Queue, Stream, Scope and Deferred for message and resource lifecycles
- Use Clock and Schedule for recovery, polling and retries
- Use layers for services; keep sockets and consumer fibers scoped
- Keep the socket reader independent of user callback execution and bounded queues
- Never import `@nats-io/*` in `src/` or reintroduce published NATS dependencies
- Official clients are permitted in tests as pinned development-only oracles
- Never use `null`; use `Option` for optional values
- Avoid `any`, owned-type assertions at trust boundaries and unbounded hidden buffers
- Add `@since` to public APIs and regenerate barrels with `pnpm codegen`

## Testing

Run `pnpm build` and `pnpm lint` before tests. Ordinary broker suites use a
JetStream-enabled server at `localhost:4222`. Isolated transport, TLS,
authentication and restart suites use the scoped Docker fixture in
`test/server.ts` and pinned `nats:2.15.0-alpine`. Use protocol barriers,
Deferred and event-based readiness rather than arbitrary sleeps. Missing
infrastructure must fail; never silently skip integration tests.

Track compatibility by observable upstream behavior. An inventory entry or
passing happy-path test does not establish exhaustive parity. Preserve
regressions for fragmentation, cancellation, permission failures, reconnect,
drain, heartbeat, queue limits and consumer recovery.
