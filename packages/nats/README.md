# @effect-messaging/nats

A NATS toolkit for Effect.

This library provides NATS bindings for Effect, implementing the `Publisher` and `Subscriber` interfaces from `@effect-messaging/core`.

## Features

- Type-safe NATS message publishing and subscribing
- Built on top of the official `nats` JavaScript client
- Full integration with Effect's ecosystem
- Automatic connection management with retries
- Error handling with structured errors

## Installation

```bash
npm install @effect-messaging/nats nats
```

## Usage

### Basic Publisher

```typescript
import { Effect } from "effect"
import * as NATSConnection from "@effect-messaging/nats/NATSConnection"
import * as NATSPublisher from "@effect-messaging/nats/NATSPublisher"

const program = Effect.gen(function* () {
  const publisher = yield* NATSPublisher.NATSPublisher
  
  yield* publisher.publish({
    subject: "hello.world",
    data: new TextEncoder().encode("Hello NATS!")
  })
})

const layer = NATSConnection.layer({ servers: ["nats://localhost:4222"] })
  .pipe(Layer.provide(NATSPublisher.layer()))

Effect.runPromise(program.pipe(Effect.provide(layer)))
```

### Basic Subscriber

```typescript
import { Effect } from "effect"
import * as NATSConnection from "@effect-messaging/nats/NATSConnection"
import * as NATSSubscriber from "@effect-messaging/nats/NATSSubscriber"
import * as NATSMessage from "@effect-messaging/nats/NATSMessage"

const handler = Effect.gen(function* () {
  const message = yield* NATSMessage.NATSMessage
  const data = NATSMessage.string(message)
  yield* Effect.log(`Received message: ${data}`)
})

const program = Effect.gen(function* () {
  const subscriber = yield* NATSSubscriber.NATSSubscriber
  yield* subscriber.subscribe(handler)
})

const layer = NATSConnection.layer({ servers: ["nats://localhost:4222"] })
  .pipe(Layer.provide(NATSSubscriber.layer({ subject: "hello.world" })))

Effect.runPromise(program.pipe(Effect.provide(layer)))
```

## Requirements

- NATS server running locally or accessible via network
- Node.js 18+ (for modern Effect features)

## License

MIT