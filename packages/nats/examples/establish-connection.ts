import { NATSConnection } from "@effect-messaging/nats"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  // Your application logic that requires a NATS connection
  const connection = yield* NATSConnection.NATSConnection
  const server = yield* connection.getServer

  yield* Effect.logInfo(`connected to ${server}`)

  // Get connection stats
  const stats = yield* connection.stats
  yield* Effect.logInfo(`messages sent: ${stats.outMsgs}, received: ${stats.inMsgs}`)

  // Measure round-trip time
  const rtt = yield* connection.rtt
  yield* Effect.logInfo(`round-trip time: ${rtt}ms`)
})

const runnable = program.pipe(
  // provide the NATS Connection dependency
  Effect.provide(NATSConnection.layerNode({ servers: ["localhost:4222"] }))
)

// Run the program
Effect.runPromise(runnable)
