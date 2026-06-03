---
"@effect-messaging/core": patch
"@effect-messaging/amqp": patch
"@effect-messaging/nats": patch
---

Add `producerSpanRelation` subscriber option (`"parent" | "link"`). It controls how the span extracted from the message headers (e.g. W3C `traceparent`) relates to the consumer span:

- `"link"` (default): each consumed message handler runs in a new root span, and the extracted span is attached as a `SpanLink` instead of being used as the parent, producing a separate but correlated trace.
- `"parent"`: the extracted span is used as the parent, so the consumer span continues the producer's trace.

**Behavior change:** the default is `"link"`. Previously the consumer span always continued the producer's trace (equivalent to `"parent"`). With this release, consumers start a new root trace per message by default and link back to the producer span. This keeps per-message traces short and bounded and avoids skewing sampling, while preserving correlation via the `SpanLink`. To restore the previous behavior, set `producerSpanRelation: "parent"`.
