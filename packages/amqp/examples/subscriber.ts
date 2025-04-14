import { AMQPChannel, AMQPConnection, AMQPConsumeMessage, AMQPSubscriber } from "@effect-messaging/amqp"
import { Effect } from "effect"

const messageHandler = Effect.gen(function*(_) {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${message.content.toString()}`)
})

const program = Effect.gen(function*(_) {
  const subscriber = yield* AMQPSubscriber.make("my-queue")

  // The subscriber will automatically handle message ack and nack
  // based on the success or failure of the message handler
  yield* subscriber.subscribe(messageHandler)
})

const runnable = program.pipe(
  // provide the AMQP Channel dependency
  Effect.provide(AMQPChannel.layer),
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
