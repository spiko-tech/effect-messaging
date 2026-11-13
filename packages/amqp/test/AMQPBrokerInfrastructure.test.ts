import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { completeOwnedCreation } from "./brokerInfrastructure.ts"

describe("broker infrastructure ownership", () => {
  it.effect("readiness remains interruptible after owned creation completes", () =>
    Effect.gen(function*() {
      const waiting = yield* Deferred.make<void>()
      let owned = false
      let cleaned = false
      const worker = yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleaned = owned
          })
        )
        yield* completeOwnedCreation(Effect.void, () => {
          owned = true
        })
        yield* Deferred.succeed(waiting, undefined)
        yield* Effect.never
      }).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(waiting)
      yield* Fiber.interrupt(worker)
      expect(cleaned).toBe(true)
    }))

  it.effect("interruption waits for daemon creation to complete before cleaning up its registered owner", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      const owned: Array<string> = []
      let created = false
      let cleanupObserved: { owned: Array<string>; created: boolean } | undefined
      const worker = yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            cleanupObserved = { owned: [...owned], created }
            created = false
          })
        )
        yield* completeOwnedCreation(
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(complete)
            created = true
          }),
          () => {
            owned.push("effect-amqp-review-unit-owned")
          }
        )
      }).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(started)
      yield* Effect.sync(() => worker.interruptUnsafe())
      expect(owned).toEqual(["effect-amqp-review-unit-owned"])
      expect(cleanupObserved).toBeUndefined()
      yield* Deferred.succeed(complete, undefined)
      expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true)
      expect(cleanupObserved).toEqual({ owned: ["effect-amqp-review-unit-owned"], created: true })
      expect(created).toBe(false)
    }))
})
