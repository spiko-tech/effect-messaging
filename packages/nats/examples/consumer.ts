import {
  JetStreamClient,
  JetStreamConsumer,
  JetStreamConsumerResponse,
  JetStreamMessage,
  NATSConnection
} from "@effect-messaging/nats"
import { Effect, Layer } from "effect"

const messageHandler = Effect.gen(function*() {
  const message = yield* JetStreamMessage.JetStreamConsumeMessage

  // Parse and process the message
  const data = message.string()
  yield* Effect.logInfo(`Received message on ${message.subject}: ${data}`)

  // Return a response to acknowledge, nak, or terminate the message
  // - ack(): Acknowledge successful processing
  // - nak({ millis? }): Negative acknowledge, optionally delay redelivery
  // - term({ reason? }): Terminate message, stop redelivery
  return JetStreamConsumerResponse.ack()
})

// Example 1: Using serve() which returns a Layer (recommended for production)
// The Layer will manage the consumer lifecycle automatically
const ConsumerLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const client = yield* JetStreamClient.JetStreamClient

    // Get an existing consumer from a stream
    // Note: The stream and consumer must already exist in NATS
    const natsConsumer = yield* client.consumers.get("my-stream", "my-consumer")

    // Create a consumer from the NATS consumer
    const consumer = yield* JetStreamConsumer.fromConsumer(natsConsumer, {
      // Optional: make message processing uninterruptible
      uninterruptible: true,
      // Optional: set a timeout for message processing
      handlerTimeout: "30 seconds"
    })

    return consumer.serve(messageHandler)
  })
)

// Create layers for the NATS connection and JetStream client
const NATSConnectionLive = NATSConnection.layerNode({ servers: ["localhost:4222"] })
const JetStreamClientLive = JetStreamClient.layer()

// To run the Layer-based program (recommended for production):
// Effect.runPromise(Layer.launch(ConsumerLive).pipe(
//   Effect.provide(JetStreamClientLive),
//   Effect.provide(NATSConnectionLive)
// ))

// Example 2: Using serveEffect() which returns an Effect (useful for scripts or tests)
const effectBasedProgram = Effect.gen(function*() {
  const client = yield* JetStreamClient.JetStreamClient

  // Get an existing consumer from a stream
  const natsConsumer = yield* client.consumers.get("my-stream", "my-consumer")

  // Create a consumer from the NATS consumer
  const consumer = yield* JetStreamConsumer.fromConsumer(natsConsumer, {
    uninterruptible: true,
    handlerTimeout: "30 seconds"
  })

  yield* Effect.logInfo("Starting to consume messages...")

  // Subscribe to messages - this will run until interrupted
  yield* consumer.serveEffect(messageHandler)
}).pipe(
  Effect.scoped,
  Effect.provide(JetStreamClientLive),
  Effect.provide(NATSConnectionLive)
)

// Run the Effect-based program
Effect.runPromise(effectBasedProgram)

// Export ConsumerLive so it can be used elsewhere (e.g., composed with other layers)
export { ConsumerLive }
