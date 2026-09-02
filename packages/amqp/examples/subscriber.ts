import {
  AMQPChannel,
  AMQPConnection,
  AMQPConsumeMessage,
  AMQPSubscriber,
  AMQPSubscriberResponse
} from "@effect-messaging/amqp"
import { Effect, Layer } from "effect"

const messageHandler = Effect.gen(function*() {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${message.content.toString()}`)

  // Return the response to indicate how the message should be handled
  return AMQPSubscriberResponse.ack()
})

const program = Effect.gen(function*() {
  const subscriber = yield* AMQPSubscriber.make("my-queue")

  // The subscriber will handle message ack/nack/reject based on the response returned by the handler
  // On handler failure, the message will be nacked
  yield* subscriber.subscribe(messageHandler)
})

const ConnectionLive = AMQPConnection.layer({
  hostname: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  heartbeat: 10
})
const MainLive = AMQPChannel.layer().pipe(Layer.provide(ConnectionLive))

const runnable = program.pipe(
  Effect.provide(MainLive),
  Effect.scoped
)

// Run the program
Effect.runPromise(runnable)
