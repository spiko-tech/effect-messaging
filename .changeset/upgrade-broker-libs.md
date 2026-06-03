---
"@effect-messaging/amqp": patch
"@effect-messaging/nats": patch
---

Upgrade messaging broker libraries to their latest versions.

- `@effect-messaging/amqp`: bump `amqplib` from `0.10.9` to `2.0.1`. `amqplib` now ships its own type definitions, so the `@types/amqplib` dev dependency has been removed.
- `@effect-messaging/nats`: bump `@nats-io/jetstream`, `@nats-io/nats-core`, and `@nats-io/transport-node` from `3.3.1` to `3.4.0`.
