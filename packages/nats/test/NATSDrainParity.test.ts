import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSError from "../src/NATSError.ts"
import * as NATSNodeConnection from "../src/NATSNodeConnection.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"
import { testConnection } from "./dependencies.ts"

const subject = () => `native.drain.${crypto.randomUUID()}`
const callbackError = (cause: unknown) => new NATSError.NATSSubscriptionError({ reason: "Drain failed", cause })

describe("Core drain parity with every upstream v3.4.0 drain case", () => {
  it.live("drain - connection drains when no subs", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.drain
      expect(yield* connection.isClosed).toBe(true)
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.provide(testConnection)))

  it.live("drain - connection drain", () =>
    Effect.gen(function*() {
      const first = yield* NATSConnection.NATSConnection
      const second = yield* NATSNodeConnection.make({ servers: "localhost:4222" })
      const address = subject()
      const received = yield* Queue.unbounded<string>()
      const started = yield* Deferred.make<void>()
      let firstCount = 0
      let secondCount = 0
      yield* first.subscribe(address, {
        queue: "workers",
        callback: (_error, message) =>
          Effect.gen(function*() {
            yield* Queue.offer(received, yield* Option.getOrThrow(message).string)
            firstCount++
            if (firstCount === 1) {
              yield* first.drain.pipe(Effect.mapError(callbackError))
              yield* Deferred.succeed(started, undefined)
            }
          }).pipe(Effect.mapError(callbackError))
      })
      yield* second.subscribe(address, {
        queue: "workers",
        callback: (_error, message) =>
          Option.getOrThrow(message).string.pipe(
            Effect.mapError(callbackError),
            Effect.tap((value) => Queue.offer(received, value)),
            Effect.tap(() => Effect.sync(() => secondCount++)),
            Effect.asVoid
          )
      })
      yield* first.flush
      yield* second.flush
      for (let index = 0; index < 1000; index++) yield* second.publish(address, `${index}`)
      yield* second.drain
      yield* Deferred.await(started)
      const values = yield* Effect.forEach(Array.from({ length: 1000 }), () => Queue.take(received))
      expect(new Set(values).size).toBe(1000)
      expect(firstCount + secondCount).toBe(1000)
      expect(secondCount).toBeGreaterThan(0)
      expect(yield* first.isClosed).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(testConnection)), { timeout: 10_000 })

  it.live("drain - subscription drain", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const values = yield* Queue.unbounded<string>()
      const drained = yield* Deferred.make<void>()
      let first: NATSSubscription.NATSSubscription | undefined
      let count = 0
      first = yield* connection.subscribe(address, {
        queue: "workers",
        callback: (_error, message) =>
          Effect.gen(function*() {
            yield* Queue.offer(values, yield* Option.getOrThrow(message).string)
            count++
            if (count === 1 && first !== undefined) {
              yield* first.drain
              yield* Deferred.succeed(drained, undefined)
            }
          }).pipe(Effect.mapError(callbackError))
      })
      yield* connection.subscribe(address, {
        queue: "workers",
        callback: (_error, message) =>
          Option.getOrThrow(message).string.pipe(
            Effect.flatMap((value) => Queue.offer(values, value)),
            Effect.mapError(callbackError),
            Effect.asVoid
          )
      })
      yield* connection.flush
      for (let index = 0; index < 1000; index++) yield* connection.publish(address, `${index}`)
      yield* connection.flush
      yield* Deferred.await(drained)
      const received = yield* Effect.forEach(Array.from({ length: 1000 }), () => Queue.take(values))
      expect(new Set(received).size).toBe(1000)
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThan(1000)
      expect(yield* first.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)), { timeout: 10_000 })

  it.live("drain - publish after drain fails", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject())
      yield* connection.drain
      expect((yield* connection.publish(subject()).pipe(Effect.flip)).code).toBe("closed")
    }).pipe(Effect.provide(testConnection)))

  it.live.each(
    [
      { name: "drain - reject reqrep during connection drain", operation: "request" },
      { name: "drain - reject drain on draining", operation: "drain" },
      { name: "drain - reject subscribe on draining", operation: "subscribe" }
    ] as const
  )("$name", ({ operation }) =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const draining = yield* connection.drain.pipe(Effect.forkChild({ startImmediately: true }))
      const failure = yield* (operation === "request" ?
        connection.request(subject()) :
        operation === "subscribe"
        ? connection.subscribe(subject())
        : connection.drain).pipe(Effect.flip)
      expect(failure.code).toBe("draining")
      yield* Fiber.join(draining)
    }).pipe(Effect.provide(testConnection)))

  it.live("drain - reject drain on closed", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.close
      expect((yield* connection.drain.pipe(Effect.flip)).code).toBe("closed")
    }).pipe(Effect.provide(testConnection)))

  it.live.each([false, true])(
    "drain - reject subscription drain on closed sub callback=%s",
    (callback) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe(subject(), callback ? { callback: () => {} } : {})
        yield* subscription.unsubscribe()
        if (!callback) expect(yield* Stream.runCollect(subscription.stream)).toEqual([])
        expect((yield* subscription.drain.pipe(Effect.flip)).reason).toContain("already closed")
      }).pipe(Effect.provide(testConnection))
  )

  it.live("drain - connection is closed after drain", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject())
      yield* connection.drain
      expect(yield* subscription.isClosed).toBe(true)
      expect(yield* connection.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("drain - reject subscription drain on closed", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject())
      yield* connection.close
      expect((yield* subscription.drain.pipe(Effect.flip)).reason).toBe("Connection closed")
    }).pipe(Effect.provide(testConnection)))

  it.live("drain - multiple sub drain shares completion", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subscription = yield* connection.subscribe(address)
      yield* connection.publish(address, "admitted")
      const first = yield* subscription.drain.pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* subscription.drain.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
        .toEqual(["admitted"])
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("drain - publisher drain", () =>
    Effect.gen(function*() {
      const publisher = yield* NATSConnection.NATSConnection
      const received = yield* Queue.unbounded<string>()
      yield* Effect.gen(function*() {
        const subscriber = yield* NATSConnection.NATSConnection
        const address = subject()
        yield* subscriber.subscribe(address, {
          callback: (_error, message) =>
            Option.getOrThrow(message).string.pipe(
              Effect.flatMap((value) => Queue.offer(received, value)),
              Effect.mapError(callbackError),
              Effect.asVoid
            )
        })
        yield* subscriber.flush
        for (let index = 0; index < 10; index++) yield* publisher.publish(address, `${index}`)
        yield* publisher.drain
        const values = yield* Effect.forEach(Array.from({ length: 10 }), () => Queue.take(received))
        expect(values).toEqual(Array.from({ length: 10 }, (_, index) => `${index}`))
      }).pipe(Effect.provide(testConnection))
    }).pipe(Effect.provide(testConnection)))
})
