import { AMQPChannel } from "@effect-messaging/amqp"
import * as AMQPNodeConnection from "@effect-messaging/amqp/AMQPNodeConnection"
import * as AMQPPublisher from "@effect-messaging/amqp/AMQPPublisher"
import { Context, Effect, Layer } from "effect"

class MyPublisher extends Context.Service<MyPublisher, AMQPPublisher.AMQPPublisher>()("MyPublisher") {}

const program = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  yield* channel.assertExchange("my-exchange", "direct", { durable: true })
  const publisher = yield* MyPublisher

  yield* publisher.publish({
    exchange: "my-exchange",
    routingKey: "my-routing-key",
    content: new TextEncoder().encode("{ \"hello\": \"world\" }"),
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

const PublisherLive = Layer.effect(MyPublisher, AMQPPublisher.make())
const ConnectionLive = AMQPNodeConnection.layer({
  hostname: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  heartbeat: 10
})
const MainLive = PublisherLive.pipe(
  Layer.provideMerge(AMQPChannel.layer({ confirm: true })),
  Layer.provide(ConnectionLive)
)

const runnable = program.pipe(Effect.provide(MainLive))

// Run the program
Effect.runPromise(runnable)
