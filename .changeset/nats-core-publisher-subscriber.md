---
"@effect-messaging/nats": minor
---

Add NATSPublisher and NATSSubscriber for NATS Core (without JetStream)

- `NATSPublisher`: Implements the `Publisher` interface from `@effect-messaging/core` using NATS Core publish (fire-and-forget)
- `NATSSubscriber`: Implements the `Subscriber` interface from `@effect-messaging/core` using NATS Core subscriptions
- Both include OpenTelemetry tracing with distributed trace context propagation via headers
- `NATSSubscriber` supports `uninterruptible` and `handlerTimeout` options
- Note: NATS Core has no persistence - messages published before subscription starts are lost
