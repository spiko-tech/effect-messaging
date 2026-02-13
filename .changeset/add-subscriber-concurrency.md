---
"@effect-messaging/amqp": minor
---

Add `prefetch` option to `AMQPChannel.consume()` (default: 50) and `concurrency` option to `AMQPSubscriberOptions` to override the channel prefetch value. Previously, subscribers used unlimited prefetch, which could overwhelm consumers when many messages were queued.
