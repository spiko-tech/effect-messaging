# Agent Guidelines for @effect-messaging/nats

## Purpose

Effect bindings for NATS and JetStream. This package mimics the architecture of `@nats-io/*` libraries but exposes Effect-style functions instead of plain JavaScript functions.

**Key modules:**

- `NATSConnection` - Core NATS connection (publish/subscribe/request)
- `JetStreamClient` - JetStream client for stream and consumer access
- `JetStreamProducer` - Producer implementation for JetStream (implements `@effect-messaging/core/Producer`)
- `JetStreamConsumer` - Consumer implementation for JetStream (implements `@effect-messaging/core/Consumer`)
- `JetStreamConsumerMessages` - Low-level NATS consumer wrapper with Effect operations
- `JetStreamConsumerResponse` - Response types for consumer message handling (ack/nak/term)
- `NATSProducer` - Producer implementation for NATS Core (implements `@effect-messaging/core/Producer`)
- `NATSConsumer` - Consumer implementation for NATS Core (implements `@effect-messaging/core/Consumer`)
- `JetStreamConsumerAPI` - Consumer management API
- `JetStreamStreamAPI` - Stream management API
- `JetStreamDirectStreamAPI` - Direct stream API for low-latency reads
- `JetStreamManager` - High-level stream and consumer management
- `JetStreamStoredMessage` - Wrapped JetStream stored message with Effect operations
- `JetStreamLister` - Wrapped JetStream Lister with Effect operations
- `NATSQueuedIterator` - Wrapped NATS QueuedIterator with Effect operations
- `NATSSubscription` - Subscription handling
- `NATSMessage` - Message utilities
- `NATSError` - Tagged errors

## Architecture

- Wraps `@nats-io/nats-core`, `@nats-io/jetstream`, and `@nats-io/transport-node`
- Layer-based dependency injection for NATS components
- Scope-based resource management for connections and subscriptions
- All operations return `Effect` instead of promises or callbacks
- Use `Parameters<>` utility type for API method signatures to match upstream types
- Avoid `any` types - use proper type casting with internal types when needed
- Never use `null` - always use `Option` from Effect for optional values

## Testing

- Tests require a running NATS server at `localhost:4222` (use `docker-compose up -d` from root)
- Test dependencies available in `test/dependencies.ts`
