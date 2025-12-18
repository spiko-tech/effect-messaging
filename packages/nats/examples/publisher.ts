import { JetStreamClient, JetStreamPublisher, NATSConnection } from "@effect-messaging/nats"
import { Context, Effect, Layer } from "effect"

class MyPublisher extends Context.Tag("MyPublisher")<MyPublisher, JetStreamPublisher.JetStreamPublisher>() {}

const program = Effect.gen(function*() {
  const publisher = yield* MyPublisher

  yield* publisher.publish({
    subject: "orders.created",
    payload: JSON.stringify({ orderId: "12345", amount: 99.99 }),
    options: {
      msgID: "order-12345" // Optional: for deduplication
    }
  })

  yield* Effect.logInfo("Message published successfully")
})

// Create a layer that provides the publisher
const PublisherLive = Layer.effect(MyPublisher, JetStreamPublisher.make())

// Create layers for the NATS connection and JetStream client
const NATSConnectionLive = NATSConnection.layerNode({ servers: ["localhost:4222"] })
const JetStreamClientLive = JetStreamClient.layer()

// Compose all layers
const MainLive = PublisherLive.pipe(
  Layer.provide(JetStreamClientLive),
  Layer.provide(NATSConnectionLive)
)

const runnable = program.pipe(
  Effect.provide(MainLive),
  Effect.scoped
)

// Run the program
Effect.runPromise(runnable)
