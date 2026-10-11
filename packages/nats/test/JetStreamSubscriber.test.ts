import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import * as JetStreamMessage from "../src/JetStreamMessage.ts"
import * as JetStreamPublisher from "../src/JetStreamPublisher.ts"
import * as JetStreamSubscriber from "../src/JetStreamSubscriber.ts"
import * as Response from "../src/JetStreamSubscriberResponse.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeTestConsumer, makeTestStream, testJetStream } from "./dependencies.ts"

const stream = "SUBSCRIBER_TEST_STREAM"
const consumerName = "SUBSCRIBER_TEST_CONSUMER"
const subject = "subscriber.test.subject"
const setup = Effect.gen(function*() {
  yield* makeTestStream(stream, [subject])
  yield* makeTestConsumer(stream, consumerName)
  const client = yield* JetStreamClient.JetStreamClient
  return yield* client.consumers.get(stream, consumerName)
})
const publish = (publisher: JetStreamPublisher.JetStreamPublisher, text: string) =>
  publisher.publish({
    subject,
    payload: new TextEncoder().encode(text)
  })

describe("JetStreamSubscriber", { concurrent: false }, () => {
  it.live("consumes and acknowledges published events in order", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const publisher = yield* JetStreamPublisher.make()
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
      const consumed = yield* Queue.unbounded<string>()
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* JetStreamMessage.JetStreamConsumeMessage
        yield* Queue.offer(consumed, message.string())
        return Response.ack()
      })).pipe(Effect.forkChild)
      for (const text of ["one", "two", "three"]) {
        yield* publish(publisher, text)
        expect(yield* Queue.take(consumed)).toBe(text)
      }
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))

  it.live.each([undefined, "5 seconds"] as const)(
    "finishes and acknowledges an in-flight handler on interruption, handlerTimeout=%s",
    (handlerTimeout) =>
      Effect.gen(function*() {
        const consumer = yield* setup
        const publisher = yield* JetStreamPublisher.make()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const subscriber = yield* JetStreamSubscriber.fromConsumer(
          consumer,
          handlerTimeout === undefined ? {} : { handlerTimeout }
        )
        const running = yield* subscriber.subscribe(Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          yield* Deferred.succeed(finished, undefined)
          return Response.ack()
        })).pipe(Effect.forkChild)
        yield* publish(publisher, "in-flight")
        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(finished)
        yield* Fiber.join(interruption)
        const connection = yield* NATSConnection.NATSConnection
        yield* connection.flush
        const manager = yield* JetStreamManager.JetStreamManager
        const info = yield* manager.consumers.info(stream, consumerName)
        expect(info.num_ack_pending).toBe(0)
        expect(info.ack_floor.stream_seq).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(testJetStream))
  )

  it.live("times out an in-flight handler and redelivers its message", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const publisher = yield* JetStreamPublisher.make()
      const interrupted = yield* Deferred.make<void>()
      const redelivered = yield* Deferred.make<JetStreamMessage.JetStreamMessage>()
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer, { handlerTimeout: "25 millis" })
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* JetStreamMessage.JetStreamConsumeMessage
        if (!message.redelivered) {
          return yield* Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        }
        yield* Deferred.succeed(redelivered, message)
        return Response.ack()
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "timeout")
      yield* Deferred.await(interrupted)
      const message = yield* Deferred.await(redelivered)
      expect(message.redelivered).toBe(true)
      expect(message.string()).toBe("timeout")
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))

  it.live("negative acknowledges failed handlers and succeeds on redelivery", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const publisher = yield* JetStreamPublisher.make()
      const attempts = yield* Queue.unbounded<JetStreamMessage.JetStreamMessage>()
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* JetStreamMessage.JetStreamConsumeMessage
        yield* Queue.offer(attempts, message)
        if (!message.redelivered) return yield* Effect.fail("Simulated handler error")
        return Response.ack()
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "retry")
      const first = yield* Queue.take(attempts)
      const second = yield* Queue.take(attempts)
      expect(first.redelivered).toBe(false)
      expect(second.redelivered).toBe(true)
      expect(second.seq).toBe(first.seq)
      expect(second.info.deliveryCount).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))

  it.live("redelivers after an explicitly delayed negative acknowledgement", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const publisher = yield* JetStreamPublisher.make()
      const attempts = yield* Queue.unbounded<JetStreamMessage.JetStreamMessage>()
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* JetStreamMessage.JetStreamConsumeMessage
        yield* Queue.offer(attempts, message)
        return message.redelivered ? Response.ack() : Response.nak({ millis: 25 })
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "delayed retry")
      const first = yield* Queue.take(attempts)
      const second = yield* Queue.take(attempts)
      expect(second.redelivered).toBe(true)
      expect(second.seq).toBe(first.seq)
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))

  it.live("terminates a message and removes its pending acknowledgement", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const publisher = yield* JetStreamPublisher.make()
      const handled = yield* Deferred.make<void>()
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
      const running = yield* subscriber.subscribe(Effect.gen(function*() {
        yield* Deferred.succeed(handled, undefined)
        return Response.term({ reason: "Intentionally terminated for testing" })
      })).pipe(Effect.forkChild)
      yield* publish(publisher, "terminate")
      yield* Deferred.await(handled)
      yield* Fiber.interrupt(running)
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.flush
      const manager = yield* JetStreamManager.JetStreamManager
      expect((yield* manager.consumers.info(stream, consumerName)).num_ack_pending).toBe(0)
      const client = yield* JetStreamClient.JetStreamClient
      const fresh = yield* client.consumers.get(stream, consumerName)
      expect(yield* fresh.next({ expires: 1000 })).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))

  it.live("succeeds when the consumer is healthy", () =>
    Effect.gen(function*() {
      const consumer = yield* setup
      const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
      yield* subscriber.healthCheck
    }).pipe(Effect.scoped, Effect.provide(testJetStream)))
})
