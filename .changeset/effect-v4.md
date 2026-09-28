---
"@effect-messaging/core": minor
"@effect-messaging/amqp": minor
"@effect-messaging/nats": minor
---

Migrate to Effect v4 (`effect@4.0.0-rc.117`). Breaking: `effect` peer dependency is now `^4.0.0-rc.117` and `@effect/platform` is no longer required. Tags are now `Context.Service` keys, and `Duration.DurationInput` options are `Duration.Input`. Subscribers now wait for in-flight handlers to finish before the subscription effect completes.
