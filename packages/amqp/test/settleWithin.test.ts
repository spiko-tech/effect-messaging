import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { settleWithin } from "../src/internal/settleWithin.js"

const never = new Promise<string>(() => {})

describe("settleWithin", () => {
  it.live("resolves the fallback once the budget elapses inside a scope finalizer", () =>
    Effect.gen(function*() {
      const outcomes: Array<string> = []
      const [elapsed] = yield* Effect.timed(Effect.scoped(
        Effect.addFinalizer(() =>
          settleWithin(never, 50, "timed out").pipe(Effect.tap((outcome) => Effect.sync(() => outcomes.push(outcome))))
        )
      ))
      expect(outcomes).toEqual(["timed out"])
      expect(Duration.toMillis(elapsed)).toBeLessThan(2_000)
    }))

  it.live("returns the promise's value when it settles first", () =>
    Effect.gen(function*() {
      expect(yield* settleWithin(Promise.resolve("done"), 50, "timed out")).toBe("done")
    }))

  it.live("waits without a timer for an infinite budget", () =>
    Effect.gen(function*() {
      const later = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20))
      expect(yield* settleWithin(later, Number.POSITIVE_INFINITY, "timed out")).toBe("done")
    }))
})
