import { AMQPConnection } from "@effect-messaging/amqp"
import { Effect } from "effect"

const program = Effect.gen(function*(_) {
  // Your application logic that requires an AMQP connection
  const connection = yield* AMQPConnection.AMQPConnection
  const props = yield* connection.serverProperties

  yield* Effect.logInfo(`connected to ${props.hostname}:${props.port}`)
})

const runnable = program.pipe(
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
