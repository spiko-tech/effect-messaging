import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { closeConnection } from "../src/internal/connectionTeardown.js"

const DRAIN_TIMEOUT = Duration.millis(50)
// Wide enough that a slow machine cannot fail it, tight enough that an unbounded wait cannot pass.
const TEARDOWN_BUDGET_MILLIS = 2_000

const never = <A>() => new Promise<A>(() => {})
const settled = () => Promise.resolve()
const rejected = () => Promise.reject(new Error("already closing"))

type Call = "drain" | "close" | "closed"

const stub = (
  { close = settled, closed = never<void | Error>, drain = settled, draining = false, isClosed = false }: {
    readonly drain?: () => Promise<void>
    readonly close?: () => Promise<void>
    readonly closed?: () => Promise<void | Error>
    readonly draining?: boolean
    readonly isClosed?: boolean
  }
) => {
  const calls: Array<Call> = []
  const record = <A>(call: Call, run: () => Promise<A>) => () => {
    calls.push(call)
    return run()
  }
  return {
    calls,
    connection: {
      isClosed: () => isClosed,
      isDraining: () => draining,
      drain: record("drain", drain),
      close: record("close", close),
      closed: record("closed", closed)
    }
  }
}

const teardown = (options: Parameters<typeof stub>[0], budget: Duration.Duration = DRAIN_TIMEOUT) =>
  Effect.gen(function*() {
    const { calls, connection } = stub(options)
    const [elapsed] = yield* Effect.timed(closeConnection(connection, budget))
    return { calls, elapsedMillis: Duration.toMillis(elapsed) }
  })

describe("closeConnection", () => {
  it.live("leaves a healthy drain to finish on its own", () =>
    Effect.gen(function*() {
      const { calls } = yield* teardown({})
      expect(calls).toEqual(["drain"])
    }))

  it.live("closes the connection when the drain never settles", () =>
    Effect.gen(function*() {
      const { calls, elapsedMillis } = yield* teardown({ drain: never })
      expect(calls).toEqual(["drain", "close"])
      expect(elapsedMillis).toBeLessThan(TEARDOWN_BUDGET_MILLIS)
    }))

  it.live("closes the connection as soon as the drain rejects", () =>
    Effect.gen(function*() {
      const { calls, elapsedMillis } = yield* teardown({ drain: rejected }, Duration.seconds(1))
      expect(calls).toEqual(["drain", "close"])
      expect(elapsedMillis).toBeLessThan(500)
    }))

  it.live("does nothing when the connection is already closed", () =>
    Effect.gen(function*() {
      const { calls } = yield* teardown({ isClosed: true })
      expect(calls).toEqual([])
    }))

  it.live("waits for a drain the application already started instead of draining again", () =>
    Effect.gen(function*() {
      const { calls } = yield* teardown({ draining: true, closed: settled })
      expect(calls).toEqual(["closed"])
    }))

  it.live("closes the connection when a drain started elsewhere does not finish in time", () =>
    Effect.gen(function*() {
      const { calls, elapsedMillis } = yield* teardown({ draining: true })
      expect(calls).toEqual(["closed", "close"])
      expect(elapsedMillis).toBeLessThan(TEARDOWN_BUDGET_MILLIS)
    }))

  it.live("gives up on a close that never settles", () =>
    Effect.gen(function*() {
      const { calls, elapsedMillis } = yield* teardown({ drain: never, close: never })
      expect(calls).toEqual(["drain", "close"])
      expect(elapsedMillis).toBeLessThan(TEARDOWN_BUDGET_MILLIS)
    }))

  it.live("succeeds when the close rejects", () =>
    Effect.gen(function*() {
      const { calls } = yield* teardown({ drain: rejected, close: rejected })
      expect(calls).toEqual(["drain", "close"])
    }))

  it.live("waits without a bound when the budget is infinite", () =>
    Effect.gen(function*() {
      const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 100))
      const { calls } = yield* teardown({ drain }, Duration.infinity)
      expect(calls).toEqual(["drain"])
    }))
})
