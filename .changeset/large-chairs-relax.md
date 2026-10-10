---
"@effect-messaging/amqp": minor
---

Replace amqplib 2.2.0 with a native Effect AMQP 0-9-1 client, using the matching
@effect/platform-node 4.0.2 TCP/TLS transport and Effect 4.0.2 Schema codecs.

This is a breaking interface change: connection transport wiring moves to
AMQPNodeConnection, payloads use Uint8Array, delivery tags use bigint, and publishing
returns Effect<void> with confirmations opt-in. Core adapters use explicit subpaths
and core is an optional peer. The native 1.0.0-beta.0 client recovers connections,
channels, topology and consumers without replaying uncertain publishes; stable queue
references follow server-generated names.
