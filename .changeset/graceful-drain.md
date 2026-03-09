---
"@effect-messaging/amqp": minor
---

Add graceful drain support for AMQPSubscriber with `drainTimeout` option. When `uninterruptible: true` is set, the subscriber now waits for in-flight message handlers to finish their ack/nack before shutting down. The `drainTimeout` option controls how long to wait before giving up and force-terminating remaining handlers.
