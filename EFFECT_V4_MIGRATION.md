# Effect 4 Migration Guide

The `1.0.0` prerelease moves all packages from Effect 3 to Effect 4.0.0-rc.112. It is a major release because Effect values,
services, layers, scopes, streams, and errors from different Effect major versions are not interchangeable.

The broker migration preserves the SDK-backed public modules and behavior from:

- `@effect-messaging/core` 0.2.43
- `@effect-messaging/nats` 0.7.6
- `@effect-messaging/amqp` 0.6.5

## Dependency Upgrade

Upgrade `effect` with the messaging packages so the application has one Effect runtime:

```json
{
  "dependencies": {
    "@effect-messaging/amqp": "1.0.0-beta.0",
    "@effect-messaging/core": "1.0.0-beta.0",
    "@effect-messaging/nats": "1.0.0-beta.0",
    "effect": "4.0.0-rc.112"
  }
}
```

Do not retain Effect 3 solely for these packages. Duplicate Effect runtimes can break context-key identity, fiber behavior, and
type equality.

## Application Syntax

Effect 4 generators no longer use the adapter argument:

```ts
// Before
Effect.gen(function*(_) {
  const service = yield* _(Service)
})

// After
Effect.gen(function*() {
  const service = yield* Service
})
```

Class-style application service keys use `Context.Service`:

```ts
class OrdersPublisher extends Context.Service<
  OrdersPublisher,
  AMQPPublisher.AMQPPublisher
>()("OrdersPublisher") {}
```

Relevant Effect 4 renames in application code include:

| Effect 3                             | Effect 4                  |
| ------------------------------------ | ------------------------- |
| `Context.Tag` / `Context.GenericTag` | `Context.Service`         |
| `Effect.fork`                        | `Effect.forkChild`        |
| `Effect.forkDaemon`                  | `Effect.forkDetach`       |
| `Option.fromNullable`                | `Option.fromNullishOr`    |
| `Duration.DurationInput`             | `Duration.Input`          |
| `Effect.catchAllCause`               | `Effect.catchCause`       |
| `Effect.tapErrorCause`               | `Effect.tapCause`         |
| `Cause.isInterruptedOnly`            | `Cause.hasInterruptsOnly` |

Use scoped child fibers for ordinary application work. `forkDetach` is not a general replacement for scoped ownership.

## Preserved Broker APIs

The following namespaces remain part of the parity release:

- Core: `Publisher`, `PublisherError`, `Subscriber`, `SubscriberApp`, `SubscriberError`, `SubscriberOTel`, and
  `SubscriberRunner`.
- NATS: `NATSConnection`, `NATSMessage`, `NATSHeaders`, `NATSPublisher`, `NATSSubscriber`, `NATSSubscription`, and
  `NATSQueuedIterator`.
- JetStream: client, manager, stream, consumer, direct stream, batch, lister, stored message, publisher, subscriber, and
  subscriber response modules.
- AMQP: `AMQPConnection`, `AMQPChannel`, `AMQPConsumeMessage`, `AMQPPublisher`, `AMQPSubscriber`, and
  `AMQPSubscriberResponse`.

The 1.0 prerelease does not silently replace the NATS SDKs or `amqplib` with native protocol clients.

Published packages continue to include ESM and CommonJS entry points. Effect values from CommonJS and ESM imports must still
resolve to the same installed Effect 4 runtime.

## Validation Before Upgrading

1. Upgrade all Effect ecosystem dependencies together.
2. Verify only one `effect` version is installed with `pnpm why effect`.
3. Compile application services and generator syntax against Effect 4.
4. Run broker integration tests against the same NATS and RabbitMQ versions used in production.
5. Exercise reconnect, shutdown, redelivery, timeout, authentication, and TLS paths used by the application.
6. Review the capability matrix for release-candidate coverage gaps.

Any public operation or tested runtime behavior absent from the prerelease should be reported as a parity regression rather
than treated as an intentional redesign.
