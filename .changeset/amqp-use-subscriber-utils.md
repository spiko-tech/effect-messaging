---
"@effect-messaging/amqp": minor
---

Refactor AMQPSubscriber to use `SubscriberUtils` from `@effect-messaging/core` for handler timeout and graceful drain. Add `drainTimeout` option to `AMQPSubscriberOptions`. Fix `handlerTimeout` not working when `uninterruptible: true` is set.
