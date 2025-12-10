---
"@effect-messaging/nats": minor
---

Add JetStreamPublisher and JetStreamSubscriber that implement the core Publisher and Subscriber interfaces with OpenTelemetry tracing support. The publisher injects trace context into NATS message headers, and the subscriber extracts it to create parent-child span relationships. The subscriber automatically handles message acknowledgment (ack on success, nak on error) and provides the message to handlers via the JetStreamConsumeMessage context tag.
