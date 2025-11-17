import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { RedisConnection } from "../src"

describe("RedisConnection", () => {
  it("should establish connection", () => {
    const program = Effect.gen(function*() {
      const connection = yield* RedisConnection.RedisConnection
      const pong = yield* connection.ping
      expect(pong).toBe("PONG")
    })

    const runnable = program.pipe(
      Effect.provide(RedisConnection.layer({
        host: "localhost",
        port: 6379
      }))
    )

    return Effect.runPromise(runnable)
  })

  it("should handle connection errors", () => {
    const program = Effect.gen(function*() {
      const connection = yield* RedisConnection.RedisConnection
      yield* connection.ping
    })

    const runnable = program.pipe(
      Effect.provide(RedisConnection.layer({
        host: "invalid-host",
        port: 9999
      })),
      Effect.catchTag("RedisConnectionError", (error) => {
        expect(error.reason).toContain("Failed to establish connection")
        return Effect.void
      })
    )

    return Effect.runPromise(runnable)
  })
})
