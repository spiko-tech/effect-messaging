---
"@effect-messaging/nats": major
---

Replace the NATS 3.4.0 wrappers with an Effect 4.0.2 native protocol, scoped TCP/TLS and WebSocket transports, and JetStream client; remove published @nats-io dependencies, own public types, and add broker interoperability, recovery, adversarial and integration coverage.

Import connection options and JetStream configuration types from `NATSOptions` and `JetStreamTypes`. The underlying `.nc`, `.sub`, `.msg` and official-client iterator escape hatches have been removed. Optional fields use Effect `Option`; JetStream fetch/consume operations now require `Scope` and should run inside `Effect.scoped`. Install `@effect/platform-node` 4.0.2 when using the Node adapter.

Compatibility is audited against nats.js 3.4.0: 758 upstream cases map to native assertions, and 42 implementation-specific, separate-package or disabled cases have explicit exclusions. The audit accounts for all 800 inventory entries; integration tests use NATS 2.15.0. See `PARITY.md` for the complete mappings, API adaptations and server-version scope.
