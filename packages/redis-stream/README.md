# @effect-messaging/redis-stream

A Redis Stream toolkit for Effect.

## Installation

```bash
pnpm add @effect-messaging/redis-stream
```

## Usage

### Publisher

```typescript
import {
  RedisConnection,
  RedisStreamPublisher
} from "@effect-messaging/redis-stream"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const publisher = yield* RedisStreamPublisher.make()

  yield* publisher.publish({
    stream: "my-stream",
    data: { message: "Hello World" }
  })
})

const runnable = program.pipe(
  Effect.provide(RedisStreamPublisher.layer()),
  Effect.provide(RedisConnection.layer({ host: "localhost", port: 6379 }))
)

Effect.runPromise(runnable)
```

### Subscriber

```typescript
import {
  RedisConnection,
  RedisStreamSubscriber
} from "@effect-messaging/redis-stream"
import { Effect } from "effect"

const messageHandler = Effect.gen(function* () {
  const message = yield* RedisStreamMessage.RedisStreamMessage
  yield* Effect.logInfo(`Received: ${JSON.stringify(message.data)}`)
})

const program = Effect.gen(function* () {
  const subscriber = yield* RedisStreamSubscriber.make("my-stream")
  yield* subscriber.subscribe(messageHandler)
})

const runnable = program.pipe(
  Effect.provide(RedisStreamSubscriber.layer("my-stream")),
  Effect.provide(RedisConnection.layer({ host: "localhost", port: 6379 }))
)

Effect.runPromise(runnable)
```
