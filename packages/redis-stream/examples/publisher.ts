import { RedisConnection, RedisStreamPublisher } from "@effect-messaging/redis-stream"
import { Context, Effect } from "effect"

class MyPublisher extends Context.Tag("MyPublisher")<MyPublisher, RedisStreamPublisher.RedisStreamPublisher>() {}

const program = Effect.gen(function*(_) {
  const publisher = yield* MyPublisher

  yield* publisher.publish({
    stream: "my-stream",
    data: {
      message: "Hello World",
      timestamp: Date.now().toString(),
      type: "greeting"
    }
  })

  yield* Effect.logInfo("Message published successfully")
})

const runnable = program.pipe(
  Effect.provideServiceEffect(MyPublisher, RedisStreamPublisher.make()),
  // provide the Redis Connection dependency
  Effect.provide(RedisConnection.layer({
    host: "localhost",
    port: 6379
  }))
)

// Run the program
Effect.runPromise(runnable)
