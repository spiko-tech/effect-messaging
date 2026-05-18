---
"@effect-messaging/amqp": minor
---

Add `confirm` option to `AMQPChannelOptions`. When set to `true`, the channel
is opened in publisher-confirm mode (`createConfirmChannel`) and every
`publish` call resolves only after the broker has acknowledged the message,
giving real backpressure and durability guarantees instead of relying on the
local socket buffer. Defaults to `false` so existing callers are unaffected.
