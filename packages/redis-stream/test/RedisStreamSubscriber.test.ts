import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { RedisConnection, RedisStreamMessage, RedisStreamSubscriber } from "../src"

describe("RedisStreamSubscriber", () => {
  it("should subscribe to stream and process messages", () => {
    const program = Effect.gen(function*() {
      // First, publish a message
      const connection = yield* RedisConnection.RedisConnection
      const client = yield* connection.client

      yield* Effect.tryPromise({
        try: () => client.xAdd("test-subscriber-stream", "*", { message: "test subscriber message" }),
        catch: (error) => new Error(`Failed to publish: ${error}`)
      })

      // Then subscribe and process
      const subscriber = yield* RedisStreamSubscriber.make("test-subscriber-stream", {
        blockTimeout: 100,
        count: 1
      })

      let messageProcessed = false
      const handler = Effect.gen(function*() {
        const message = yield* RedisStreamMessage.RedisStreamMessage
        expect(message.data.message).toBe("test subscriber message")
        messageProcessed = true
      })

      // Run subscription for a short time
      yield* subscriber.subscribe(handler).pipe(
        Effect.timeout("1 second"),
        Effect.catchTag("TimeoutException", () => Effect.void)
      )

      expect(messageProcessed).toBe(true)
    })

    const runnable = program.pipe(
      Effect.provide(RedisConnection.layer({
        host: "localhost",
        port: 6379
      }))
    )

    return Effect.runPromise(runnable)
  })

  it("should handle health check", () => {
    const program = Effect.gen(function*() {
      const subscriber = yield* RedisStreamSubscriber.make("test-health-stream")

      // Health check should pass for existing stream
      yield* subscriber.healthCheck
    })

    const runnable = program.pipe(
      Effect.provide(RedisConnection.layer({
        host: "localhost",
        port: 6379
      }))
    )

    return Effect.runPromise(runnable)
  })
})
