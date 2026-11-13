import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Queue, Schedule, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode, testConnection } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

describe("AMQP resource lifecycle", () => {
  it.effect("pipelines confirms and correlates multiple acknowledgements and individual nacks", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 3 })
      const first = yield* channel.publish("", "queue", encode("first")).pipe(Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      const second = yield* channel.publish("", "queue", encode("second")).pipe(Effect.forkChild)
      yield* Queue.take(session.publishes)
      const third = yield* channel.publish("", "queue", encode("third")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 2n, multiple: true })
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* session.reply(channelId, 60, 120, { deliveryTag: 3n, multiple: false, requeue: false })
      expectFailure(yield* Fiber.join(third), { _tag: "AMQPPublishError", outcome: "Nacked" })
    }).pipe(Effect.scoped))

  it.effect("keeps confirms moving while a consumer does not drain its mailbox", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { maxPendingOperations: 4 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const stalled = yield* Deferred.make<void>()
      const messages = yield* channel.consume("queue", { prefetch: 4 })
      yield* messages.pipe(Stream.runForEach(() => Deferred.await(stalled)), Effect.forkChild)
      const consume = yield* nextMethod(session, 60, 20)
      for (let i = 1; i <= 4; i++) {
        yield* session.reply(consume.channel, 60, 60, {
          consumerTag: "synthetic-consumer",
          deliveryTag: BigInt(i),
          redelivered: false,
          exchange: "",
          routingKey: "queue"
        })
        yield* session.send(yield* Codec.encodeContentHeader(consume.channel, 1n, {}))
        yield* session.send(yield* Codec.encodeFrame(3, consume.channel, encode("x")))
      }
      yield* session.send(yield* Codec.encodeFrame(8, 0, new Uint8Array()))
      const publishing = yield* channel.publish("", "queue", encode("confirmed")).pipe(Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* Fiber.join(publishing)
      expect((yield* connection.state).state).toBe("Ready")
      yield* Deferred.succeed(stalled, undefined)
    }).pipe(Effect.scoped))

  it.effect("retires a cancelled RPC session so late replies cannot complete the next RPC", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(3) })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const first = yield* channel.assertQueue("first").pipe(Effect.forkChild)
      const request = yield* nextMethod(session, 50, 10)
      yield* Fiber.interrupt(first)
      const replacement = yield* Queue.take(broker.sessions)
      yield* connection.awaitReady
      const second = yield* channel.assertQueue("second").pipe(Effect.forkChild)
      const next = yield* nextMethod(replacement, 50, 10)
      yield* session.reply(request.channel, 50, 11, { queue: "first", messageCount: 0, consumerCount: 0 })
      yield* replacement.reply(next.channel, 50, 11, { queue: "second", messageCount: 0, consumerCount: 0 })
      expect((yield* Fiber.join(second)).queue).toBe("second")
    }).pipe(Effect.scoped))

  it.effect("classifies a lost in-flight confirm as Unknown and never replays it", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        retryConnectionSchedule: Schedule.recurs(3)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const publishing = yield* channel.publish("", "queue", encode("payload")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      yield* session.disconnect
      expectFailure(yield* Fiber.join(publishing), { _tag: "AMQPPublishError", outcome: "Unknown" })
      yield* connection.awaitReady
      const recovered = yield* Queue.take(broker.sessions)
      const next = yield* channel.publish("", "queue", encode("next")).pipe(Effect.forkChild)
      const channelId = yield* Queue.take(recovered.publishes)
      // A replay would consume sequence 1 and leave this fresh publish waiting for sequence 2.
      yield* recovered.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* Fiber.join(next)
      expect(yield* Queue.size(recovered.publishes)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("times out a missing confirm with an Unknown outcome", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, confirmTimeout: "1 second" })
      const publishing = yield* channel.publish("", "queue", encode("payload")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(publishing), { _tag: "AMQPPublishError", outcome: "Unknown" })
    }).pipe(Effect.scoped))

  it.live("permanently closes a channel without closing its connection", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* connection.createChannel()
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.close
      yield* channel.close
      expect(Exit.isFailure(yield* channel.sendToQueue(queue, encode("closed")).pipe(Effect.exit))).toBe(true)
      yield* connection.reconnect
      expect(Exit.isFailure(yield* channel.checkQueue(queue).pipe(Effect.exit))).toBe(true)
      const replacement = yield* connection.createChannel()
      yield* replacement.assertQueue("", { exclusive: true })
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("does not restore consumers cancelled before recovery", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* connection.createChannel()
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const consumer = yield* channel.consume(queue, { consumerTag: "lifecycle-cancel" })
      const consuming = yield* consumer.pipe(Stream.runDrain, Effect.forkChild)
      expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
      yield* Fiber.interrupt(consuming)
      expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
      for (let i = 0; i < 3; i++) {
        yield* connection.reconnect
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
      }
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("closes idempotently and never reconnects after shutdown", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* connection.createChannel()
      yield* channel.assertQueue("", { exclusive: true })
      yield* connection.reconnect
      yield* connection.close
      yield* connection.close
      const state = yield* connection.state
      expect(state.state).toBe("Closed")
      expect(Exit.isFailure(yield* connection.reconnect.pipe(Effect.exit))).toBe(true)
      expect(yield* connection.state).toEqual(state)
      expect(Exit.isFailure(yield* connection.createChannel().pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(testConnection)))
})
