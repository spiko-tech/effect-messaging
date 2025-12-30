import {
  AMQPChannel,
  AMQPConnection,
  AMQPConsumeMessage,
  AMQPSubscriber,
  AMQPSubscriberResponse
} from "@effect-messaging/amqp"
import { Effect } from "effect"

const messageHandler = Effect.gen(function*(_) {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${message.content.toString()}`)

  // Return the response to indicate how the message should be handled
  return AMQPSubscriberResponse.ack()
})

const program = Effect.gen(function*(_) {
  const subscriber = yield* AMQPSubscriber.make("my-queue")

  // The subscriber will handle message ack/nack/reject based on the response returned by the handler
  // On handler failure, the message will be nacked
  yield* subscriber.subscribe(messageHandler)
})

const runnable = program.pipe(
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
