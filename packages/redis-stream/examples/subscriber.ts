import { RedisConnection, RedisStreamMessage, RedisStreamSubscriber } from "@effect-messaging/redis-stream"
import { Effect } from "effect"

const messageHandler = Effect.gen(function*(_) {
  const message = yield* RedisStreamMessage.RedisStreamMessage

  // You can add your message processing logic here
  yield* Effect.logInfo(`Received message: ${JSON.stringify(message.data)}`)
  yield* Effect.logInfo(`Message ID: ${message.id}, Timestamp: ${message.timestamp}`)
})

const program = Effect.gen(function*(_) {
  const subscriber = yield* RedisStreamSubscriber.make("my-stream", {
    blockTimeout: 1000,
    count: 10
  })

  // The subscriber will automatically handle message acknowledgment
  // based on the success or failure of the message handler
  yield* subscriber.subscribe(messageHandler)
})

const runnable = program.pipe(
  // provide the Redis Connection dependency
  Effect.provide(RedisConnection.layer({
    host: "localhost",
    port: 6379
  }))
)

// Run the program
Effect.runPromise(runnable)
