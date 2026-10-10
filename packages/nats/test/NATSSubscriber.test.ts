import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSMessage from "../src/NATSMessage.ts"
import * as NATSPublisher from "../src/NATSPublisher.ts"
import * as NATSSubscriber from "../src/NATSSubscriber.ts"
import { testConnection } from "./dependencies.ts"

const subject = "nats.subscriber.test.subject"
const publish = (publisher: NATSPublisher.NATSPublisher, text: string) =>
  publisher.publish({
    subject,
    payload: new TextEncoder().encode(text)
  })

describe("NATSSubscriber", { concurrent: false }, () => {
  it.live("consumes published events in order", () =>
    Effect.gen(function*() {
      const publisher = yield* NATSPublisher.make()
      const subscriber = yield* NATSSubscriber.make(subject)
      const consumed = yield* Queue.unbounded<string>()
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* NATSMessage.NATSConsumeMessage
        yield* Queue.offer(consumed, yield* message.string)
      })).pipe(Effect.forkChild)
      for (const text of ["first", "second", "third"]) {
        yield* publish(publisher, text)
        expect(yield* Queue.take(consumed)).toBe(text)
      }
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("does not persist messages published before the subscription", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const publisher = yield* NATSPublisher.make()
      yield* publish(publisher, "before")
      yield* connection.flush
      const subscriber = yield* NATSSubscriber.make(subject)
      const consumed = yield* Queue.unbounded<string>()
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* NATSMessage.NATSConsumeMessage
        yield* Queue.offer(consumed, yield* message.string)
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "after")
      expect(yield* Queue.take(consumed)).toBe("after")
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live.each([undefined, "5 seconds"] as const)(
    "lets an in-flight handler complete when interrupted, handlerTimeout=%s",
    (handlerTimeout) =>
      Effect.gen(function*() {
        const publisher = yield* NATSPublisher.make()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const subscriber = yield* NATSSubscriber.make(
          subject,
          undefined,
          handlerTimeout === undefined ? {} : { handlerTimeout }
        )
        const subscription = yield* subscriber.subscribe(Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          yield* Deferred.succeed(finished, undefined)
        })).pipe(Effect.forkChild)
        yield* publish(publisher, "in-flight")
        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(subscription).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(finished)
        yield* Fiber.join(interruption)
        expect(yield* Deferred.isDone(finished)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(testConnection))
  )

  it.live("interrupts a handler at its configured timeout and processes the next message", () =>
    Effect.gen(function*() {
      const publisher = yield* NATSPublisher.make()
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const subscriber = yield* NATSSubscriber.make(subject, undefined, { handlerTimeout: "25 millis" })
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* NATSMessage.NATSConsumeMessage
        const text = yield* message.string
        if (text === "timeout") {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        } else {
          yield* Deferred.succeed(finished, undefined)
        }
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "timeout")
      yield* Deferred.await(started)
      yield* Deferred.await(interrupted)
      yield* publish(publisher, "next")
      yield* Deferred.await(finished)
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("continues processing when a handler fails", () =>
    Effect.gen(function*() {
      const publisher = yield* NATSPublisher.make()
      const subscriber = yield* NATSSubscriber.make(subject)
      const attempted = yield* Queue.unbounded<string>()
      const finished = yield* Deferred.make<void>()
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* NATSMessage.NATSConsumeMessage
        const text = yield* message.string
        yield* Queue.offer(attempted, text)
        if (text === "fail") return yield* Effect.fail("Simulated handler error")
        yield* Deferred.succeed(finished, undefined)
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "fail")
      expect(yield* Queue.take(attempted)).toBe("fail")
      yield* publish(publisher, "success")
      expect(yield* Queue.take(attempted)).toBe("success")
      yield* Deferred.await(finished)
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("checks subscription health and reports a closed connection", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscriber = yield* NATSSubscriber.make(subject)
      yield* subscriber.healthCheck
      yield* connection.close
      const error = yield* subscriber.healthCheck.pipe(Effect.flip)
      expect(error._tag).toBe("SubscriberError")
    }).pipe(Effect.scoped, Effect.provide(testConnection)))
})
