---
"@effect-messaging/amqp": minor
---

Add `confirm` and `confirmTimeout` options to `AMQPChannelOptions`. With
`confirm: true` the channel is opened in publisher-confirm mode and `publish` /
`sendToQueue` resolve only once the broker has acknowledged the message, or fail
with an `AMQPChannelError` on a nack, on a channel close, or after
`confirmTimeout` (default 30 seconds). Both default to a plain channel, so
existing callers are unaffected.
