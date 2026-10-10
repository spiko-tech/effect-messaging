import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Schedule, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod, type Session } from "./syntheticBroker.ts"

const sendDelivery = Effect.fnUntraced(function*(session: Session, channel: number, tag: bigint) {
  yield* session.reply(channel, 60, 60, {
    consumerTag: "synthetic-consumer",
    deliveryTag: tag,
    exchange: "",
    routingKey: "queue"
  })
  yield* session.send(yield* Codec.encodeContentHeader(channel, 1n, {}))
  yield* session.send(yield* Codec.encodeFrame(3, channel, encode("x")))
})

const nextRequeue = Effect.fnUntraced(function*(session: Session) {
  while (true) {
    const method = yield* Queue.take(session.methods)
    if (method.classId === 60 && (method.methodId === 90 || method.methodId === 120)) {
      expect(method.fields.requeue).toBe(true)
      return method.fields.deliveryTag
    }
  }
})

describe("AMQP review regressions", () => {
  it.effect("the receive watchdog retires a silent session even when a heartbeat write is stalled", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ heartbeat: 2 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 2,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const generation = (yield* connection.state).generation
      yield* session.pauseWrites
      yield* TestClock.adjust("1 second")
      yield* Queue.take(session.stalledWrites)
      yield* TestClock.adjust("5 seconds")
      const replacement = yield* Queue.take(broker.sessions)
      yield* connection.awaitReady
      expect(replacement).not.toBe(session)
      expect((yield* connection.state).generation).toBeGreaterThan(generation)
      // Releasing a retired transport's backpressure must not revive its writer.
      yield* session.resumeWrites
      const channel = yield* connection.createChannel()
      yield* channel.prefetch(1)
      expect((yield* Queue.takeAll(session.frames)).some((frame) => frame.type === 8)).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("requeues undispatched deliveries when taking part of a buffered batch", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const messages = yield* channel.consume("queue", { prefetch: 4 })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const received: Array<bigint> = []
      const consuming = yield* messages.pipe(
        Stream.take(2),
        Stream.runForEach((message) =>
          Effect.gen(function*() {
            received.push(message.fields.deliveryTag)
            if (received.length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }
            yield* channel.ack(message)
          })
        ),
        Effect.forkChild
      )
      const consumer = yield* nextMethod(session, 60, 20)
      yield* sendDelivery(session, consumer.channel, 1n)
      yield* Deferred.await(started)
      for (const tag of [2n, 3n, 4n]) yield* sendDelivery(session, consumer.channel, tag)
      // The RPC reply is an ordered-reader barrier, not an arbitrary delay.
      yield* channel.prefetch(4)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(consuming)
      expect(received).toEqual([1n, 2n])
      const requeued = [yield* nextRequeue(session), yield* nextRequeue(session)]
      expect(requeued).toEqual([3n, 4n])
      yield* channel.prefetch(1)
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("broker cancellation fails visibly and requeues buffered but not actively handled deliveries", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const messages = yield* channel.consume("queue", { prefetch: 3 })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const consuming = yield* messages.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            yield* channel.ack(message)
          })
        ),
        Effect.exit,
        Effect.forkChild
      )
      const consumer = yield* nextMethod(session, 60, 20)
      yield* sendDelivery(session, consumer.channel, 1n)
      yield* Deferred.await(started)
      yield* sendDelivery(session, consumer.channel, 2n)
      yield* sendDelivery(session, consumer.channel, 3n)
      yield* channel.prefetch(3)
      yield* session.reply(consumer.channel, 60, 30, { consumerTag: "synthetic-consumer", noWait: false })
      const requeued = yield* Effect.gen(function*() {
        let replied = false
        const tags: Array<AMQPTypes.FieldValue> = []
        while (!replied || tags.length < 2) {
          const method = yield* Queue.take(session.methods)
          if (method.classId !== 60) continue
          if (method.methodId === 31) replied = true
          if (method.methodId === 90 || method.methodId === 120) {
            expect(method.fields.requeue).toBe(true)
            tags.push(method.fields.deliveryTag)
          }
        }
        return tags
      })
      expect(requeued).toEqual([2n, 3n])
      yield* Deferred.succeed(release, undefined)
      expectFailure(yield* Fiber.join(consuming), { _tag: "AMQPChannelError" })
      const acknowledgements = yield* Queue.takeAll(session.methods)
      expect(acknowledgements).toEqual(expect.arrayContaining([
        expect.objectContaining({ classId: 60, methodId: 80, fields: expect.objectContaining({ deliveryTag: 1n }) })
      ]))
    }).pipe(Effect.scoped))

  it.effect("reuses channel capacity after successful closes without retiring the connection", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ channelMax: 1 })
      const connection = yield* AMQPConnection.make(broker.factory, { channelMax: 1 })
      const generation = (yield* connection.state).generation
      for (let i = 0; i < 8; i++) {
        const channel = yield* connection.createChannel()
        yield* channel.prefetch(1)
        yield* channel.close
      }
      expect((yield* connection.state).generation).toBe(generation)
    }).pipe(Effect.scoped))

  it.effect("reclaimed channel IDs never make an old settlement valid for a replacement channel", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ channelMax: 1 })
      const connection = yield* AMQPConnection.make(broker.factory, { channelMax: 1 })
      const session = yield* Queue.take(broker.sessions)
      const old = yield* connection.createChannel()
      const oldStream = yield* old.consume("queue")
      const receivingOld = yield* oldStream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      const original = yield* nextMethod(session, 60, 20)
      yield* sendDelivery(session, original.channel, 1n)
      const [oldMessage] = yield* Fiber.join(receivingOld)
      yield* old.close
      const current = yield* connection.createChannel()
      const currentStream = yield* current.consume("queue")
      const receivingCurrent = yield* currentStream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      const replacement = yield* nextMethod(session, 60, 20)
      expect(replacement.channel).toBe(original.channel)
      yield* sendDelivery(session, replacement.channel, 1n)
      const [currentMessage] = yield* Fiber.join(receivingCurrent)
      expectFailure(yield* current.ack(oldMessage).pipe(Effect.exit), { _tag: "AMQPSettlementError", kind: "Stale" })
      yield* current.ack(currentMessage)
      const settlements = (yield* Queue.takeAll(session.methods)).filter((method) =>
        method.classId === 60 && method.methodId === 80
      )
      expect(settlements).toHaveLength(1)
    }).pipe(Effect.scoped))

  it.effect("a late confirm releases its retained capacity without being attributed to a later publish", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, confirmTimeout: "1 second", maxUnconfirmed: 1 })
      const first = yield* channel.publish("", "queue", encode("first")).pipe(Effect.exit, Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(first), { _tag: "AMQPPublishError", outcome: "Unknown" })
      const second = yield* channel.publish("", "queue", encode("second")).pipe(Effect.forkChild)
      yield* channel.prefetch(1)
      expect(yield* Queue.size(session.publishes)).toBe(0)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 2n, multiple: false })
      yield* Fiber.join(second)
    }).pipe(Effect.scoped))

  it.effect("releases retained header reservations when returned messages are dispatched", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, { frameMax: 4096, maxBufferedBytes: 8192 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const opened = yield* nextMethod(session, 20, 10)
      for (let i = 0; i < 5; i++) {
        const receiving = yield* channel.returns.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        yield* session.reply(opened.channel, 60, 50, {
          replyCode: 312,
          replyText: "NO_ROUTE",
          exchange: "",
          routingKey: "x"
        })
        yield* session.send(
          yield* Codec.encodeContentHeader(opened.channel, 0n, {
            headers: { binary: new Uint8Array(3000) }
          })
        )
        expect(yield* Fiber.join(receiving)).toHaveLength(1)
        expect((yield* connection.state).state).toBe("Ready")
      }
    }).pipe(Effect.scoped))

  it.effect("locally rejects oversized method frames without sending them or poisoning RPC state", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096, automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory, { frameMax: 4096 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const oversized = yield* channel.assertQueue("oversized", { arguments: { huge: new Uint8Array(5000) } })
        .pipe(Effect.exit)
      expectFailure(oversized, {})
      yield* channel.assertQueue("valid")
      expect((yield* Queue.takeAll(session.frames)).every((frame) => frame.payload.length + 8 <= 4096)).toBe(true)
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("charges retained headers against the aggregate buffer budget even for empty returned bodies", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        frameMax: 4096,
        maxBufferedBytes: 8192,
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const opened = yield* nextMethod(session, 20, 10)
      const failed = yield* connection.changes.pipe(
        Stream.filter((state) => state.state === "Failed"),
        Stream.runHead,
        Effect.forkChild
      )
      const properties: AMQPTypes.MessageProperties = { headers: { binary: new Uint8Array(3000) } }
      for (let i = 0; i < 2; i++) {
        yield* session.reply(opened.channel, 60, 50, {
          replyCode: 312,
          replyText: "NO_ROUTE",
          exchange: "",
          routingKey: "x"
        })
        yield* session.send(yield* Codec.encodeContentHeader(opened.channel, 0n, properties))
        if (i === 0) {
          yield* channel.prefetch(1)
          expect((yield* connection.state).state).toBe("Ready")
        }
      }
      yield* Fiber.join(failed)
      expect((yield* connection.state).error).toBeDefined()
      expectFailure(yield* connection.awaitReady.pipe(Effect.exit), {})
    }).pipe(Effect.scoped))
})
