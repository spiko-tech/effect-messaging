---
"@effect-messaging/amqp": minor
"@effect-messaging/core": patch
---

Replace amqplib 2.2.0 with a native Effect AMQP 0-9-1 client, using the matching
@effect/platform-node 4.1.0 TCP/TLS transport and Effect 4.1.0 Schema codecs.

This is a breaking interface change: connection transport wiring moves to
AMQPNodeConnection, payloads use Uint8Array, delivery tags use bigint, and publishing
returns Effect<void> with confirmations opt-in. Core adapters use explicit subpaths
and core is an optional peer. The native client recovers connections,
channels, topology and consumers without replaying uncertain publishes; stable queue
references follow server-generated names.

Add transactions, genuine automatic acknowledgements, Direct Reply-To, unlimited
wire prefetch, option aliases and PLAIN/AMQPLAIN/EXTERNAL authentication. Snapshot
external values once, preserve numeric wire widths, retain cross-channel topology
dependencies and reserve outbound capacity before body framing. Independent-client
interoperability uses amqplib 2.2.0 as a development-only reference.

Qualify RabbitMQ 4.3.6 restart durability, quorum failover/partitions, native TLS/mTLS,
authentication/ACL failures, acknowledgement timeouts and memory/disk alarms in
owned disposable infrastructure, without stopping shared broker services.

On Effect 4.1.0, use one bounded subscriber worker owner across AMQP recovery,
preserving cancellation-before-drain, tracing and settlement authority.
