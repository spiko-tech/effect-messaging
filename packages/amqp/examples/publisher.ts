import { AMQPChannel, AMQPConnection, AMQPPublisher } from "@effect-messaging/amqp"
import { Context, Effect, Layer } from "effect"

class MyPublisher extends Context.Service<MyPublisher, AMQPPublisher.AMQPPublisher>()("MyPublisher") {}

const program = Effect.gen(function*() {
  const publisher = yield* MyPublisher

  yield* publisher.publish({
    exchange: "my-exchange",
    routingKey: "my-routing-key",
    content: Buffer.from("{ \"hello\": \"world\" }"),
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
const ConnectionLive = AMQPConnection.layer({
  hostname: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  heartbeat: 10
})
const MainLive = PublisherLive.pipe(
  Layer.provide(AMQPChannel.layer()),
  Layer.provide(ConnectionLive)
)

const runnable = program.pipe(
  Effect.provide(MainLive),
  Effect.scoped
)

// Run the program
Effect.runPromise(runnable)
