import { describe, expect, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as Heartbeat from "../src/internal/heartbeat.ts"

const monitor = (maxOut = 2, cancelAfter = 0) =>
  Effect.gen(function*() {
    const notifications = yield* Queue.unbounded<number>()
    const heartbeat = yield* Heartbeat.make(250, (missed) => Queue.offer(notifications, missed).pipe(Effect.as(true)), {
      maxOut,
      cancelAfter
    })
    return { heartbeat, notifications }
  })

describe("Exact upstream idle heartbeat laws", () => {
  it.effect("idleheartbeat - basic", () =>
    Effect.gen(function*() {
      const { heartbeat, notifications } = yield* monitor()
      for (let index = 0; index < 8; index++) {
        yield* TestClock.adjust("100 millis")
        yield* heartbeat.work
      }
      yield* heartbeat.cancel
      expect(yield* Queue.size(notifications)).toBe(0)
      expect((yield* heartbeat.state).active).toBe(false)
    }).pipe(Effect.scoped))

  it.effect.each([1, 5])("idleheartbeat - timeout maxOut=%s", (maxOut) =>
    Effect.gen(function*() {
      const { heartbeat, notifications } = yield* monitor(maxOut)
      yield* TestClock.adjust((maxOut + 1) * 250)
      expect(yield* Queue.take(notifications)).toBe(maxOut)
      expect((yield* heartbeat.state).active).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("idleheartbeat - timeout recover", () =>
    Effect.gen(function*() {
      const { heartbeat, notifications } = yield* monitor(5)
      yield* TestClock.adjust("1000 millis")
      expect((yield* heartbeat.state).missed).toBe(3)
      yield* heartbeat.work
      expect((yield* heartbeat.state).missed).toBe(0)
      yield* TestClock.adjust("730 millis")
      expect((yield* heartbeat.state).missed).toBeLessThanOrEqual(4)
      yield* heartbeat.cancel
      expect(yield* Queue.size(notifications)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("idleheartbeat - timeout autocancel", () =>
    Effect.gen(function*() {
      const { heartbeat, notifications } = yield* monitor(4, 2000)
      for (let index = 0; index < 20; index++) {
        yield* TestClock.adjust("100 millis")
        yield* heartbeat.work
      }
      const state = yield* heartbeat.state
      expect(state.cancelAfter).toBe(2000)
      expect(state.active).toBe(false)
      expect(state.count).toBeGreaterThanOrEqual(6)
      expect(yield* Queue.size(notifications)).toBe(0)
      yield* TestClock.adjust("5000 millis")
      expect((yield* heartbeat.state).count).toBe(state.count)
    }).pipe(Effect.scoped))

  it.effect("idleheartbeat - change", () =>
    Effect.gen(function*() {
      const { heartbeat } = yield* monitor(2, 2000)
      const initial = yield* heartbeat.state
      yield* heartbeat.change(3000, 3000, 4)
      const state = yield* heartbeat.state
      expect(state).toMatchObject({ interval: 3000, cancelAfter: 3000, maxOut: 4, active: true })
      expect(state.generation).toBe(initial.generation + 1)
      yield* TestClock.adjust("2500 millis")
      expect((yield* heartbeat.state).count).toBe(0)
      yield* TestClock.adjust("500 millis")
      expect((yield* heartbeat.state).active).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("idleheartbeat - restart", () =>
    Effect.gen(function*() {
      const { heartbeat } = yield* monitor(2, 2000)
      yield* TestClock.adjust("100 millis")
      const initial = yield* heartbeat.state
      yield* heartbeat.restart
      const state = yield* heartbeat.state
      expect(state.active).toBe(true)
      expect(state.generation).toBe(initial.generation + 1)
      yield* TestClock.adjust("150 millis")
      expect((yield* heartbeat.state).count).toBe(0)
      yield* TestClock.adjust("100 millis")
      expect((yield* heartbeat.state).count).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("restart grants a fresh idle lease after a cancelled monitor", () =>
    Effect.gen(function*() {
      const { heartbeat, notifications } = yield* monitor(1)
      yield* heartbeat.cancel
      yield* TestClock.adjust("5000 millis")
      yield* heartbeat.restart
      yield* TestClock.adjust("250 millis")
      expect(yield* Queue.size(notifications)).toBe(0)
      expect((yield* heartbeat.state).active).toBe(true)
      yield* TestClock.adjust("250 millis")
      expect(yield* Queue.take(notifications)).toBe(1)
    }).pipe(Effect.scoped))
})
