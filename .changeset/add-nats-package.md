---
"@effect-messaging/nats": minor
---

Add new @effect-messaging/nats package

This release introduces a new NATS messaging library that implements the Publisher and Subscriber interfaces from @effect-messaging/core. The package provides:

- Type-safe NATS message publishing and subscribing
- Built on top of the official `nats` JavaScript client  
- Full integration with Effect's ecosystem
- Automatic connection management with retries
- Error handling with structured errors

Key features:
- NATSConnection: Connection management with scoped resources
- NATSPublisher: Publisher interface implementation  
- NATSSubscriber: Subscriber interface implementation
- NATSMessage: Message utilities for data access
- NATSError: Structured error types