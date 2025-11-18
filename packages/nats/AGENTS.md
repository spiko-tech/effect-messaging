# Agent Guidelines for @effect-messaging/nats

## Purpose

Effect bindings for NATS and JetStream. This package mimics the architecture of `@nats-io/*` libraries but exposes Effect-style functions instead of plain JavaScript functions.

**Key modules:**

- `NATSConnection` - Core NATS connection (publish/subscribe/request)
- `NATSJetStreamClient` - JetStream consumer and publisher
- `NATSJetStreamManager` - Stream and consumer management
- `NATSSubscription` - Subscription handling
- `NATSMessage` - Message utilities
- `NATSError` - Tagged errors

## Architecture

- Wraps `@nats-io/nats-core`, `@nats-io/jetstream`, and `@nats-io/transport-node`
- Layer-based dependency injection for NATS components
- Scope-based resource management for connections and subscriptions
- All operations return `Effect` instead of promises or callbacks

## Testing

- Tests require a running NATS server at `localhost:4222` (use `docker-compose up -d` from root)
- Test dependencies available in `test/dependencies.ts`
