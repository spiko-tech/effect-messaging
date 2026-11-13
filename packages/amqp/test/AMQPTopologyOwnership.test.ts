import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Schedule, Stream } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { decode, encode, testConfirmChannel } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

describe("AMQP topology ownership", () => {
  it.effect("restores a closed channel's exclusive queue on its surviving consumer channel", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      // Explicit reconnect needs one supervisor retry after retiring the original session.
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(1) })
      const session = yield* Queue.take(broker.sessions)
      const owner = yield* connection.createChannel()
      const consumer = yield* connection.createChannel()
      const declaring = yield* owner.assertQueue("", { exclusive: true }).pipe(Effect.forkChild)
      const declaration = yield* nextMethod(session, 50, 10)
      yield* session.reply(declaration.channel, 50, 11, { queue: "original", messageCount: 0, consumerCount: 0 })
      const queue = yield* Fiber.join(declaring)
      expect(queue.queue).toBe("original")
      const messages = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const stream = yield* consumer.consume(queue)
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(messages, message)), Effect.forkChild)
      yield* nextMethod(session, 60, 20)
      yield* owner.close
      yield* Queue.takeAll(session.methods)
      const reconnecting = yield* connection.reconnect.pipe(Effect.forkChild)
      const replacement = yield* Queue.take(broker.sessions)
      let restored = yield* Queue.take(replacement.methods)
      while (restored.classId !== 50 && !(restored.classId === 60 && restored.methodId === 20)) {
        restored = yield* Queue.take(replacement.methods)
      }
      expect([restored.classId, restored.methodId]).toEqual([50, 10])
      expect(restored.fields.exclusive).toBe(true)
      yield* replacement.reply(restored.channel, 50, 11, {
        queue: "regenerated",
        messageCount: 0,
        consumerCount: 0
      })
      const registration = yield* nextMethod(replacement, 60, 20)
      yield* Fiber.join(reconnecting)
      expect(queue.queue).toBe("regenerated")
      expect(registration.fields.queue).toBe("regenerated")
      expectFailure(yield* owner.prefetch(1).pipe(Effect.exit), { _tag: "AMQPChannelError" })
      yield* consumer.sendToQueue(queue, encode("after"))
      expect((yield* nextMethod(replacement, 60, 40)).fields.routingKey).toBe("regenerated")
      yield* replacement.reply(registration.channel, 60, 60, {
        consumerTag: "synthetic-consumer",
        deliveryTag: 1n,
        exchange: "",
        routingKey: queue.queue
      })
      yield* replacement.send(yield* Codec.encodeContentHeader(registration.channel, 5n, {}))
      yield* replacement.send(yield* Codec.encodeFrame(3, registration.channel, encode("after")))
      const message = yield* Queue.take(messages)
      expect(decode(message.content)).toBe("after")
      yield* consumer.ack(message)
    }).pipe(Effect.scoped))

  for (const routing of [false, true]) {
    it.live(
      `keeps exclusive queues connection-owned after their declarer closes${routing ? " with upstream routing" : ""}`,
      () =>
        Effect.gen(function*() {
          const consumer = yield* AMQPChannel.AMQPChannel
          const connection = consumer.connection
          const owner = yield* connection.createChannel()
          const binder = yield* connection.createChannel()
          const queue = yield* owner.assertQueue("", { exclusive: true })
          const original = queue.queue
          const source = `effect-ownership-${original}.source`
          const destination = `effect-ownership-${original}.destination`
          if (routing) {
            yield* owner.assertExchange(source, "direct", { durable: false })
            yield* owner.assertExchange(destination, "direct", { durable: false })
            yield* binder.bindExchange(destination, source, "key")
            yield* binder.bindQueue(queue, destination, "key")
            yield* Effect.addFinalizer(() =>
              Effect.all([consumer.deleteExchange(source), consumer.deleteExchange(destination)]).pipe(Effect.ignore)
            )
          }
          const messages = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
          const stream = yield* consumer.consume(queue)
          yield* stream.pipe(Stream.runForEach((message) => Queue.offer(messages, message)), Effect.forkChild)
          yield* owner.close
          yield* binder.close
          // Exclusive queues belong to the connection, not the declaring channel.
          yield* consumer.sendToQueue(queue, encode("before"))
          const before = yield* Queue.take(messages)
          expect(decode(before.content)).toBe("before")
          yield* consumer.ack(before)
          yield* connection.reconnect
          expect(queue.queue).not.toBe(original)
          expectFailure(yield* owner.prefetch(1).pipe(Effect.exit), { _tag: "AMQPChannelError" })
          if (routing) yield* consumer.publish(source, "key", encode("after"))
          else yield* consumer.sendToQueue(queue, encode("after"))
          const message = yield* Queue.take(messages)
          expect(decode(message.content)).toBe("after")
          yield* consumer.ack(message)
        }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
      15000
    )
  }
})
