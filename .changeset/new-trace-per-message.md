---
"@effect-messaging/core": minor
"@effect-messaging/amqp": minor
"@effect-messaging/nats": minor
---

Add `newTracePerMessage` subscriber option. When enabled, each consumed message handler runs in a new root span, and the span extracted from the message headers (e.g. W3C `traceparent`) is attached as a `SpanLink` instead of being used as the parent.

The option is opt-in and defaults to `false` (legacy behavior: extracted span is used as the parent of the consumer span).
