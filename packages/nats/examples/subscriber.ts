import {
  JetStreamClient,
  JetStreamMessage,
  JetStreamSubscriber,
  JetStreamSubscriberResponse,
  NATSConnection
} from "@effect-messaging/nats"
import { Effect } from "effect"

const messageHandler = Effect.gen(function*() {
  const message = yield* JetStreamMessage.JetStreamConsumeMessage

  // Parse and process the message
  const data = message.string()
  yield* Effect.logInfo(`Received message on ${message.subject}: ${data}`)

  // Return a response to acknowledge, nak, or terminate the message
  // - ack(): Acknowledge successful processing
  // - nak({ millis? }): Negative acknowledge, optionally delay redelivery
  // - term({ reason? }): Terminate message, stop redelivery
  return JetStreamSubscriberResponse.ack()
})

const program = Effect.gen(function*() {
  const client = yield* JetStreamClient.JetStreamClient

  // Get an existing consumer from a stream
  // Note: The stream and consumer must already exist in NATS
  const consumer = yield* client.consumers.get("my-stream", "my-consumer")

  // Create a subscriber from the consumer
  const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer, {
    // Optional: make message processing uninterruptible
    uninterruptible: true,
    // Optional: set a timeout for message processing
    handlerTimeout: "30 seconds"
  })

  yield* Effect.logInfo("Starting to consume messages...")

  // Subscribe to messages - this will run until interrupted
  yield* subscriber.subscribe(messageHandler)
})

// Create layers for the NATS connection and JetStream client
const NATSConnectionLive = NATSConnection.layerNode({ servers: ["localhost:4222"] })
const JetStreamClientLive = JetStreamClient.layer()

const runnable = program.pipe(
  Effect.provide(JetStreamClientLive),
  Effect.provide(NATSConnectionLive)
)

// Run the program
Effect.runPromise(runnable)
