import { AMQPChannel, AMQPConsumeMessage } from "@effect-messaging/amqp"
import * as AMQPNodeConnection from "@effect-messaging/amqp/AMQPNodeConnection"
import * as AMQPSubscriber from "@effect-messaging/amqp/AMQPSubscriber"
import * as AMQPSubscriberResponse from "@effect-messaging/amqp/AMQPSubscriberResponse"
import { Effect, Layer } from "effect"

const messageHandler = Effect.gen(function*() {
  const message = yield* AMQPConsumeMessage.AMQPConsumeMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${new TextDecoder().decode(message.content)}`)

  // Return the response to indicate how the message should be handled
  return AMQPSubscriberResponse.ack()
})

const program = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  const queue = yield* channel.assertQueue("my-queue", { durable: true })
  const subscriber = yield* AMQPSubscriber.make(queue)

  // The subscriber will handle message ack/nack/reject based on the response returned by the handler
  // On handler failure, the message will be nacked
  yield* subscriber.subscribe(messageHandler)
})

const ConnectionLive = AMQPNodeConnection.layer({
  hostname: "localhost",
  port: 5672,
  username: "guest",
  password: "guest",
  heartbeat: 10
})
const MainLive = AMQPChannel.layer().pipe(Layer.provide(ConnectionLive))

const runnable = program.pipe(Effect.provide(MainLive))

// Run the program
Effect.runPromise(runnable)
