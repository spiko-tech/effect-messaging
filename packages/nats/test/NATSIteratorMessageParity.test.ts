import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import type * as Cause from "effect/Cause"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSQueuedIterator from "../src/NATSQueuedIterator.ts"
import { testConnection } from "./dependencies.ts"

const subject = () => `native.iterator.${crypto.randomUUID()}`

describe("Core JSON and iterator parity", () => {
  it.live.each([
    { name: "string", value: "helloworld" },
    { name: "empty", value: "" },
    { name: "null", value: null },
    { name: "number", value: 10 },
    { name: "false", value: false },
    { name: "true", value: true },
    { name: "empty array", value: [] },
    { name: "any array", value: [1, "a", false, Number("3.1416")] },
    { name: "empty object", value: {} },
    { name: "object", value: { a: 1, b: false, c: "name", d: Number("3.1416") } }
  ])("json - $name", ({ value }) =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address, { max: 1 })
      yield* connection.publish(address, JSON.stringify(value))
      const message = Option.getOrThrow(yield* Stream.runHead(subscription.stream))
      expect(yield* message.json()).toEqual(value)
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - unsubscribe breaks and closes", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      yield* connection.publish(address, "a")
      yield* connection.publish(address, "b")
      yield* connection.flush
      const values = yield* subscription.stream.pipe(
        Stream.tap(() => subscription.unsubscribe()),
        Stream.mapEffect((message) => message.string),
        Stream.runCollect
      )
      expect(values).toEqual(["a", "b"])
      expect(yield* subscription.getReceived).toBe(2)
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - autounsub breaks and closes", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address, { max: 2 })
      for (const value of ["a", "b", "ignored"]) yield* connection.publish(address, value)
      expect(yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
        .toEqual(["a", "b"])
      expect(yield* subscription.getReceived).toBe(2)
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - unsubscribing closes", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      const seen = yield* Deferred.make<void>()
      const running = yield* subscription.stream.pipe(
        Stream.tap(() => Deferred.succeed(seen, undefined)),
        Stream.mapEffect((message) => message.string),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* connection.publish(address, "accepted")
      yield* Deferred.await(seen)
      yield* subscription.unsubscribe()
      expect(yield* Fiber.join(running)).toEqual(["accepted"])
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - connection close closes", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      yield* connection.publish(address, "accepted")
      yield* connection.flush
      yield* connection.close
      expect(yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
        .toEqual(["accepted"])
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - cb subs fail iterator", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const seen = yield* Deferred.make<void>()
      const address = subject()
      const subscription = yield* connection.subscribe(address, {
        callback: () => Deferred.succeed(seen, undefined).pipe(Effect.asVoid)
      })
      expect((yield* Stream.runDrain(subscription.stream).pipe(Effect.flip)).reason).toContain("Callback")
      yield* connection.publish(address)
      yield* Deferred.await(seen)
      expect(yield* connection.isClosed).toBe(false)
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - cb message counts", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address, { callback: () => {} })
      for (let index = 0; index < 3; index++) yield* connection.publish(address)
      yield* subscription.drain
      expect(yield* subscription.getReceived).toBe(3)
      expect(yield* subscription.getProcessed).toBe(3)
      expect(yield* subscription.getPending).toBe(0)
    }).pipe(Effect.provide(testConnection)))

  it.effect("iterators - push on done is noop", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.make<string, Cause.Done>()
      const iterator = NATSQueuedIterator.make(queue, () => Queue.end(queue).pipe(Effect.asVoid), Effect.succeed(3))
      for (const value of ["a", "b", "c"]) yield* Queue.offer(queue, value)
      yield* iterator.stop()
      expect(yield* Stream.runCollect(iterator.stream)).toEqual(["a", "b", "c"])
      expect(yield* Queue.offer(queue, "ignored")).toBe(false)
      expect(yield* iterator.getReceived).toBe(3)
      expect(yield* iterator.getProcessed).toBe(3)
      expect(yield* iterator.getPending).toBe(0)
    }))

  it.live("iterators - break cleans up", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      yield* connection.publish(address, "first")
      yield* subscription.stream.pipe(Stream.take(1), Stream.runDrain)
      yield* connection.flush
      expect(yield* subscription.isClosed).toBe(true)
      yield* connection.publish(address, "later")
      yield* connection.flush
      expect(yield* subscription.getReceived).toBe(1)
    }).pipe(Effect.provide(testConnection)))

  it.live("iterators - sync iterator", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      const pull = yield* Stream.toPull(subscription.stream.pipe(Stream.rechunk(1)))
      yield* connection.publish(address, "a")
      expect(yield* (yield* pull)[0].string).toBe("a")
      yield* connection.publish(address, "b")
      expect(yield* (yield* pull)[0].string).toBe("b")
      const waiting = yield* pull.pipe(Effect.forkChild({ startImmediately: true }))
      expect(waiting.pollUnsafe()).toBeUndefined()
      const concurrent = yield* Stream.runDrain(subscription.stream).pipe(Effect.flip)
      expect(concurrent.reason).toContain("already being consumed")
      expect(yield* subscription.isClosed).toBe(false)
      yield* connection.publish(address, "c")
      expect(yield* (yield* Fiber.join(waiting))[0].string).toBe("c")
      const callback = yield* connection.subscribe(subject(), { callback: () => {} })
      expect((yield* Stream.runDrain(callback.stream).pipe(Effect.flip)).reason).toContain("Callback")
    }).pipe(Effect.scoped, Effect.provide(testConnection)))
})
