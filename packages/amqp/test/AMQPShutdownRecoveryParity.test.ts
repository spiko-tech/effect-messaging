import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Queue, Schedule, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

describe("AMQP broker shutdown during topology restoration", () => {
  it.effect("keeps logical-channel recovery recoverable when a broker connection close interrupts it", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(1) })
      const first = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const declaring = yield* channel.assertQueue("restored", { durable: true }).pipe(Effect.forkChild)
      const declaration = yield* nextMethod(first, 50, 10)
      yield* first.reply(declaration.channel, 50, 11, { queue: "restored", messageCount: 0, consumerCount: 0 })
      yield* Fiber.join(declaring)
      yield* first.reply(declaration.channel, 20, 40, {
        replyCode: 404,
        replyText: "NOT_FOUND channel recovery trigger",
        classId: 50,
        methodId: 10
      })
      yield* nextMethod(first, 50, 10)
      yield* first.pauseWrites
      yield* first.reply(0, 10, 50, {
        replyCode: 320,
        replyText: "CONNECTION_FORCED during logical-channel recovery",
        classId: 50,
        methodId: 10
      })
      yield* Queue.take(first.stalledWrites)
      yield* TestClock.adjust("1 second")
      const replacement = yield* Queue.take(broker.sessions)
      const restored = yield* nextMethod(replacement, 50, 10)
      yield* replacement.reply(restored.channel, 50, 11, { queue: "restored", messageCount: 0, consumerCount: 0 })
      yield* connection.awaitReady
      yield* channel.prefetch(1)
      expect(yield* connection.state).toMatchObject({ state: "Ready", generation: 2 })
    }).pipe(Effect.scoped))

  it.effect("restores the same logical channel and consumer after broker 320 interrupts restoration", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(2) })
      const first = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const declaring = yield* channel.assertQueue("restored", { durable: true }).pipe(Effect.forkChild)
      const declaration = yield* nextMethod(first, 50, 10)
      yield* first.reply(declaration.channel, 50, 11, { queue: "restored", messageCount: 0, consumerCount: 0 })
      const queue = yield* Fiber.join(declaring)
      const stream = yield* channel.consume(queue)
      const consuming = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* nextMethod(first, 60, 20)
      const reconnecting = yield* connection.reconnect.pipe(Effect.forkChild)
      const replacement = yield* Queue.take(broker.sessions)
      yield* nextMethod(replacement, 50, 10)
      yield* replacement.pauseWrites
      yield* replacement.reply(0, 10, 50, {
        replyCode: 320,
        replyText: "CONNECTION_FORCED during recovery",
        classId: 50,
        methodId: 10
      })
      yield* Queue.take(replacement.stalledWrites)
      yield* TestClock.adjust("1 second")
      const next = yield* Queue.take(broker.sessions)
      const restored = yield* Deferred.make<number>()
      yield* Effect.forever(
        Queue.take(next.methods).pipe(Effect.flatMap((method) =>
          method.classId === 60 && method.methodId === 20
            ? Deferred.succeed(restored, method.channel)
            : method.classId === 50 && method.methodId === 10
            ? next.reply(method.channel, 50, 11, { queue: "restored", messageCount: 0, consumerCount: 0 })
            : Effect.void
        ))
      ).pipe(Effect.forkChild)
      yield* Fiber.join(reconnecting)
      const qos = yield* channel.prefetch(1).pipe(Effect.exit)
      expect(Exit.isSuccess(qos)).toBe(true)
      const restoredChannel = yield* Deferred.await(restored)
      expect(restoredChannel).toBeGreaterThan(0)
      const body = encode("after interrupted restoration")
      yield* next.reply(restoredChannel, 60, 60, {
        consumerTag: "synthetic-consumer",
        deliveryTag: 1n,
        redelivered: true,
        exchange: "",
        routingKey: "restored"
      })
      yield* next.send(yield* Codec.encodeContentHeader(restoredChannel, BigInt(body.length), {}))
      yield* next.send(yield* Codec.encodeFrame(3, restoredChannel, body))
      const [message] = yield* Fiber.join(consuming)
      expect(message.content).toEqual(body)
      expect(message.fields.redelivered).toBe(true)
      yield* channel.ack(message)
      expect(yield* connection.state).toMatchObject({ state: "Ready", generation: 3 })
    }).pipe(Effect.scoped))

  for (const stalled of [false, true]) {
    it.effect(`preserves permanent broker 403 during recovery with ${stalled ? "stalled" : "responsive"} CloseOk writer`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(1) })
        const first = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const declaring = yield* channel.assertQueue("restored").pipe(Effect.forkChild)
        const declaration = yield* nextMethod(first, 50, 10)
        yield* first.reply(declaration.channel, 50, 11, { queue: "restored", messageCount: 0, consumerCount: 0 })
        yield* Fiber.join(declaring)
        const states = yield* Queue.unbounded<AMQPConnection.ConnectionState>()
        yield* connection.changes.pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkChild({ startImmediately: true })
        )
        const reconnecting = yield* connection.reconnect.pipe(Effect.exit, Effect.forkChild)
        const replacement = yield* Queue.take(broker.sessions)
        yield* nextMethod(replacement, 50, 10)
        if (stalled) yield* replacement.pauseWrites
        yield* replacement.reply(0, 10, 50, {
          replyCode: 403,
          replyText: "ACCESS_REFUSED during recovery",
          classId: 50,
          methodId: 10
        })
        if (stalled) {
          yield* Queue.take(replacement.stalledWrites)
          yield* TestClock.adjust("1 second")
        } else {
          yield* nextMethod(replacement, 10, 51)
        }
        expectFailure(yield* Fiber.join(reconnecting), { _tag: "AMQPConnectionError", replyCode: 403 })
        const observed = yield* Queue.clear(states)
        expect(observed.some((state) => state.generation === 2 && state.state === "Ready")).toBe(false)
        expect((yield* connection.state).state).toBe("Failed")
        expect(yield* Queue.size(broker.sessions)).toBe(0)
      }).pipe(Effect.scoped))
  }
})
