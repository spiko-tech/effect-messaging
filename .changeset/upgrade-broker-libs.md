---
"@effect-messaging/amqp": minor
"@effect-messaging/nats": patch
---

Upgrade messaging broker libraries to their latest versions.

- `@effect-messaging/amqp`: bump `amqplib` from `0.10.9` to `2.0.1` (the `peerDependency` is now `^2.0.1`, so consumers must upgrade `amqplib` to `2.x`). `amqplib` now ships its own type definitions, so the `@types/amqplib` dev dependency was removed in favour of `@types/node`.

  **Behavioral change (amqplib v2.0.0):** passing `heartbeat: 0` in the connection options now disables heartbeats entirely, overriding any value suggested by the server. Previously `0` meant "no preference" and the server's suggested value was used. To keep the old behavior, omit `heartbeat` (or pass `null`) instead of `0`.

- `@effect-messaging/nats`: bump `@nats-io/jetstream`, `@nats-io/nats-core`, and `@nats-io/transport-node` from `3.3.1` to `3.4.0`.
