import { RedisConnection } from "@effect-messaging/redis-stream"
import { Effect } from "effect"

const program = Effect.gen(function*(_) {
  const connection = yield* RedisConnection.RedisConnection

  // Test the connection with a ping
  const pong = yield* connection.ping
  yield* Effect.logInfo(`Redis connection established: ${pong}`)

  // Test basic Redis operations
  const client = yield* connection.client
  yield* Effect.tryPromise({
    try: () => client.set("test-key", "test-value"),
    catch: (error) => new Error(`Failed to set key: ${error}`)
  })

  const value = yield* Effect.tryPromise({
    try: () => client.get("test-key"),
    catch: (error) => new Error(`Failed to get key: ${error}`)
  })

  yield* Effect.logInfo(`Retrieved value: ${value}`)
})

const runnable = program.pipe(
  Effect.provide(RedisConnection.layer({
    host: "localhost",
    port: 6379
  }))
)

// Run the program
Effect.runPromise(runnable)
