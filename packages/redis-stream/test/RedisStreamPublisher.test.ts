import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { RedisConnection, RedisStreamPublisher } from "../src"

describe("RedisStreamPublisher", () => {
  it("should publish message to stream", () => {
    const program = Effect.gen(function*() {
      const publisher = yield* RedisStreamPublisher.make()

      yield* publisher.publish({
        stream: "test-stream",
        data: { message: "test message", type: "test" }
      })

      // Verify message was published by reading it back
      const connection = yield* RedisConnection.RedisConnection
      const client = yield* connection.client

      const result = yield* Effect.tryPromise({
        try: () =>
          client.xRead({
            key: "test-stream",
            id: "0"
          }, {
            COUNT: 1
          }),
        catch: (error) => new Error(`Failed to read stream: ${error}`)
      })

      expect(result).toBeDefined()
      expect(result![0].messages).toHaveLength(1)
      expect(result![0].messages[0].message.message).toBe("test message")
    })

    const runnable = program.pipe(
      Effect.provide(RedisStreamPublisher.layer()),
      Effect.provide(RedisConnection.layer({
        host: "localhost",
        port: 6379
      }))
    )

    return Effect.runPromise(runnable)
  })

  it("should handle publish errors", () => {
    const program = Effect.gen(function*() {
      const publisher = yield* RedisStreamPublisher.make()

      // Try to publish to an invalid stream (empty string)
      yield* publisher.publish({
        stream: "",
        data: { message: "test" }
      })
    })

    const runnable = program.pipe(
      Effect.provide(RedisStreamPublisher.layer()),
      Effect.provide(RedisConnection.layer({
        host: "localhost",
        port: 6379
      })),
      Effect.catchTag("PublisherError", (error) => {
        expect(error.reason).toContain("Failed to publish message")
        return Effect.void
      })
    )

    return Effect.runPromise(runnable)
  })
})
