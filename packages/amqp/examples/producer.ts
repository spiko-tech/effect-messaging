import { AMQPChannel, AMQPConnection, AMQPProducer } from "@effect-messaging/amqp"
import { Context, Effect } from "effect"

class MyProducer extends Context.Tag("MyProducer")<MyProducer, AMQPProducer.AMQPProducer>() {}

const program = Effect.gen(function*(_) {
  const producer = yield* MyProducer

  yield* producer.send({
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

const runnable = program.pipe(
  Effect.provideServiceEffect(MyProducer, AMQPProducer.make()),
  // provide the AMQP Channel dependency
  Effect.provide(AMQPChannel.layer()),
  // provide the AMQP Connection dependency
  Effect.provide(AMQPConnection.layer({
    hostname: "localhost",
    port: 5672,
    username: "guest",
    password: "guest",
    heartbeat: 10
  }))
)

// Run the program
Effect.runPromise(runnable)
