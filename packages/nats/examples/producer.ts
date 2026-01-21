import { JetStreamClient, JetStreamProducer, NATSConnection } from "@effect-messaging/nats"
import { Context, Effect, Layer } from "effect"

class MyProducer extends Context.Tag("MyProducer")<MyProducer, JetStreamProducer.JetStreamProducer>() {}

const program = Effect.gen(function*() {
  const producer = yield* MyProducer

  yield* producer.send({
    subject: "orders.created",
    payload: JSON.stringify({ orderId: "12345", amount: 99.99 }),
    options: {
      msgID: "order-12345" // Optional: for deduplication
    }
  })

  yield* Effect.logInfo("Message published successfully")
})

// Create a layer that provides the producer
const ProducerLive = Layer.effect(MyProducer, JetStreamProducer.make())

// Create layers for the NATS connection and JetStream client
const NATSConnectionLive = NATSConnection.layerNode({ servers: ["localhost:4222"] })
const JetStreamClientLive = JetStreamClient.layer()

// Compose all layers
const MainLive = ProducerLive.pipe(
  Layer.provide(JetStreamClientLive),
  Layer.provide(NATSConnectionLive)
)

const runnable = program.pipe(
  Effect.provide(MainLive),
  Effect.scoped
)

// Run the program
Effect.runPromise(runnable)
