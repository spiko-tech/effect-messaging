# `effect-messaging`

A message broker toolkit for Effect.

### AMQP protocol features

- 🔌 Effectful wrappers for AMQP Connection and Channel
- 🔄 Auto-reconnect functionality when the connection is lost
- 🧘 Seamless consumption continuation after reconnection
- 🔭 Distributed tracing support (spans propagate from publishers to subscribers)

> [!WARNING]
> This project is currently **under development**. Please note that future releases might introduce breaking changes.

## Quickstart Guide

### AMQP with `@effect-messaging/amqp`

#### 1. Establish a Connection

First, you need to establish a connection to your AMQP server:

```typescript
import { AMQPConnection } from "@effect-messaging/amqp"
import { Effect } from "effect"

const program = Effect.gen(function* (_) {
  // Your application logic that requires an AMQP connection
  const connection = yield* AMQPConnection.AMQPConnection
  const props = yield* connection.serverProperties

  yield* Effect.logInfo(`connected to ${props.hostname}:${props.port}`)
})

const runnable = program.pipe(
  // provide the AMQP Connection dependency
  Effect.provide(
    AMQPConnection.layer({
      hostname: "localhost",
      port: 5672,
      username: "guest",
      password: "guest",
      heartbeat: 10
    })
  )
)

// Run the program
Effect.runPromise(runnable)
```

#### 2. Create a Publisher

To send messages, create a publisher:

```typescript
import {
  AMQPChannel,
  AMQPConnection,
  AMQPPublisher
} from "@effect-messaging/amqp"
import { Context, Effect } from "effect"

class MyPublisher extends Context.Tag("MyPublisher")<
  MyPublisher,
  AMQPPublisher.AMQPPublisher
>() {}

const program = Effect.gen(function* (_) {
  const publisher = yield* MyPublisher

  yield* publisher.publish({
    exchange: "my-exchange",
    routingKey: "my-routing-key",
    content: Buffer.from('{ "hello": "world" }'),
    options: {
      persistent: true,
      contentType: "application/json",
      expiration: 60000,
      headers: {
        "x-custom-header": "custom-value"
      }
    }
  })
})

const runnable = program.pipe(
  Effect.provideServiceEffect(MyPublisher, AMQPPublisher.make()),
  // provide the AMQP Channel dependency
  Effect.provide(AMQPChannel.layer),
  // provide the AMQP Connection dependency
  Effect.provide(
    AMQPConnection.layer({
      hostname: "localhost",
      port: 5672,
      username: "guest",
      password: "guest",
      heartbeat: 10
    })
  )
)

// Run the program
Effect.runPromise(runnable)
```

#### 3. Create a Subscriber

To receive messages, create a subscriber:

```typescript
import {
  AMQPChannel,
  AMQPConnection,
  AMQPConsumeMessage,
  AMQPSubscriber
} from "@effect-messaging/amqp"
import { Effect } from "effect"

const messageHandler = Effect.gen(function* (_) {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${message.content.toString()}`)
})

const program = Effect.gen(function* (_) {
  const subscriber = yield* AMQPSubscriber.make("my-queue")

  // The subscriber will automatically handle message ack and nack
  // based on the success or failure of the message handler
  yield* subscriber.subscribe(messageHandler)
})

const runnable = program.pipe(
  // provide the AMQP Channel dependency
  Effect.provide(AMQPChannel.layer),
  // provide the AMQP Connection dependency
  Effect.provide(
    AMQPConnection.layer({
      hostname: "localhost",
      port: 5672,
      username: "guest",
      password: "guest",
      heartbeat: 10
    })
  )
)

// Run the program
Effect.runPromise(runnable)
```

## Roadmap

### Common abstractions for message brokers `@effect-messaging/core`

**Basic abstractions:**

- [x] Add a `Publisher` interface
- [x] Add a `Subscriber` interface

**Application-level API for consumer apps:**

- [ ] Add support for routing based on the topic / subject
- [ ] Add support for middlewares

**Higher-level declarative API:**

- [ ] Add declarative API to define messages schemas
- [ ] Generate publisher based on message definitions
- [ ] Generate consumer app based on message definitions
- [ ] AsyncAPI specification generation

### AMQP implementation

- [x] Effect wrappers for AMQP Connection & AMQP Channel
- [x] Implement publisher and subscriber
- [x] Integration tests
- [x] Add examples & documentation

### Implementation for other message brokers

- [ ] Kafka
- [ ] NATS
- [ ] Google PubSub
