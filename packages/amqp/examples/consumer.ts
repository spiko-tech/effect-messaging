import {
  AMQPChannel,
  AMQPConnection,
  AMQPConsumeMessage,
  AMQPConsumer,
  AMQPConsumerResponse
} from "@effect-messaging/amqp"
import { Effect, Layer } from "effect"

const messageHandler = Effect.gen(function*(_) {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${message.content.toString()}`)

  // Return the response to indicate how the message should be handled
  return AMQPConsumerResponse.ack()
})

// Example 1: Using serve() which returns a Layer (recommended for production)
// The Layer will manage the consumer lifecycle automatically
const ConsumerLive = Layer.unwrapEffect(
  Effect.gen(function*(_) {
    const consumer = yield* AMQPConsumer.make("my-queue")
    return consumer.serve(messageHandler)
  })
)

const ConnectionLive = AMQPConnection.layer({
  hostname: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  heartbeat: 10
})

// To run the Layer-based program (recommended for production):
// Effect.runPromise(Layer.launch(ConsumerLive).pipe(
//   Effect.provide(AMQPChannel.layer()),
//   Effect.provide(ConnectionLive)
// ))

// Example 2: Using serveEffect() which returns an Effect (useful for scripts or tests)
const effectBasedProgram = Effect.gen(function*(_) {
  const consumer = yield* AMQPConsumer.make("my-queue")

  // The consumer will handle message ack/nack/reject based on the response returned by the handler
  // On handler failure, the message will be nacked
  yield* consumer.serveEffect(messageHandler)
}).pipe(
  Effect.scoped,
  // provide the AMQP Channel dependency
  Effect.provide(AMQPChannel.layer()),
  // provide the AMQP Connection dependency
  Effect.provide(ConnectionLive)
)

// Run the Effect-based program
Effect.runPromise(effectBasedProgram)

// Export ConsumerLive so it can be used elsewhere (e.g., composed with other layers)
export { ConsumerLive }
