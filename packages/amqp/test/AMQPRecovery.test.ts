import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Queue, Stream } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import { expectFailure } from "./assertions.ts"
import { decode, encode, testConfirmChannel } from "./dependencies.ts"

describe("AMQP recovery", () => {
  it.live("deletions remove cross-channel declarations and their dependent bindings from desired topology", () =>
    Effect.gen(function*() {
      const operator = yield* AMQPChannel.AMQPChannel
      const connection = operator.connection
      const owner = yield* connection.createChannel()
      const queue = yield* owner.assertQueue("", { exclusive: true })
      const originalName = queue.queue
      const exchange = `effect-native-${originalName}.deleted`
      yield* owner.assertExchange(exchange, "direct", { durable: false })
      yield* Effect.addFinalizer(() =>
        Effect.scoped(Effect.gen(function*() {
          const cleanup = yield* connection.createChannel()
          yield* cleanup.deleteExchange(exchange)
        })).pipe(Effect.ignore)
      )
      yield* operator.bindQueue(queue, exchange, "key")
      yield* operator.deleteExchange(exchange)
      yield* operator.deleteQueue(queue)
      yield* connection.reconnect
      expect(queue.queue).toBe(originalName)
      // The channel that owned the binding must remain usable after its targets
      // are removed, rather than failing restoration on a stale binding.
      yield* operator.prefetch(1)
      const queueInspector = yield* connection.createChannel()
      expectFailure(yield* queueInspector.checkQueue(originalName).pipe(Effect.exit), {
        _tag: "AMQPChannelError",
        replyCode: 404
      })
      const exchangeInspector = yield* connection.createChannel()
      expectFailure(yield* exchangeInspector.checkExchange(exchange).pipe(Effect.exit), {
        _tag: "AMQPChannelError",
        replyCode: 404
      })
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))

  it.live("restores cross-channel queue references before dependent bindings and consumers", () =>
    Effect.gen(function*() {
      const first = yield* AMQPChannel.AMQPChannel
      const owner = yield* first.connection.createChannel()
      const queue = yield* owner.assertQueue("", { exclusive: true })
      const exchange = `effect-native-${queue.queue}.cross-channel`
      yield* first.assertExchange(exchange, "direct", { durable: false })
      yield* Effect.addFinalizer(() => first.deleteExchange(exchange).pipe(Effect.ignore))
      yield* first.bindQueue(queue, exchange, "key")
      const received = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const stream = yield* first.consume(queue, { prefetch: 1 })
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(received, message)), Effect.forkChild)
      yield* first.publish(exchange, "key", encode("before"))
      yield* first.ack(yield* Queue.take(received))
      const oldName = queue.queue
      yield* first.connection.reconnect
      expect(queue.queue).not.toBe(oldName)
      yield* first.publish(exchange, "key", encode("after"))
      const after = yield* Queue.take(received)
      expect(decode(after.content)).toBe("after")
      yield* first.ack(after)
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))

  it.live("never replays purge, get or publish commands during recovery", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const seed = yield* channel.assertQueue("", { exclusive: true })
      const queue = yield* channel.assertQueue(`effect-native-${seed.queue}.no-replay`, { durable: true })
      yield* Effect.addFinalizer(() => channel.deleteQueue(queue).pipe(Effect.ignore))
      yield* channel.purgeQueue(queue)
      yield* channel.sendToQueue(queue, encode("only-once"))
      const original = yield* channel.get(queue)
      expect(Option.isSome(original)).toBe(true)
      yield* channel.connection.reconnect
      expect((yield* channel.checkQueue(queue)).messageCount).toBe(1)
      const redelivered = yield* channel.get(queue)
      expect(Option.isSome(redelivered)).toBe(true)
      if (Option.isSome(redelivered)) {
        expect(decode(redelivered.value.content)).toBe("only-once")
        expect(redelivered.value.fields.redelivered).toBe(true)
        yield* channel.ack(redelivered.value)
      }
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))

  it.live("remembers successful declaration values rather than mutable caller options", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const seed = yield* channel.assertQueue("", { exclusive: true })
      const options = { durable: true, arguments: { "x-message-ttl": 60000 } }
      const queue = yield* channel.assertQueue(`effect-native-${seed.queue}.snapshot`, options)
      yield* Effect.addFinalizer(() => channel.deleteQueue(queue).pipe(Effect.ignore))
      options.durable = false
      options.arguments["x-message-ttl"] = 1000
      yield* channel.connection.reconnect
      yield* channel.sendToQueue(queue, encode("unchanged"))
      expect((yield* channel.checkQueue(queue)).messageCount).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))

  it.live(
    "rebinds server-named exclusive queue references and transparently recovers a consume stream",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const originalName = queue.queue
        const exchange = `effect-native-${originalName}.recovery`
        yield* channel.assertExchange(exchange, "direct", { durable: false })
        yield* Effect.addFinalizer(() => channel.deleteExchange(exchange).pipe(Effect.ignore))
        yield* channel.bindQueue(queue, exchange, "key")
        const messages = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const stream = yield* channel.consume(queue, { prefetch: 1 })
        yield* stream.pipe(Stream.runForEach((message) => Queue.offer(messages, message)), Effect.forkChild)
        yield* channel.publish(exchange, "key", encode("before"))
        const before = yield* Queue.take(messages)
        expect(decode(before.content)).toBe("before")
        yield* channel.ack(before)
        for (let i = 0; i < 3; i++) {
          const previousName = queue.queue
          yield* channel.connection.reconnect
          expect(queue.queue).not.toBe(previousName)
          expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
          yield* channel.publish(exchange, "key", encode(`after-${i}`))
          const after = yield* Queue.take(messages)
          expect(decode(after.content)).toBe(`after-${i}`)
          yield* channel.ack(after)
        }
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
    { timeout: 15000 }
  )

  it.live("never applies a stale acknowledgement to a new generation delivery", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.sendToQueue(queue, encode("old"))
      const old = yield* channel.get(queue)
      expect(Option.isSome(old)).toBe(true)
      if (Option.isNone(old)) return
      yield* channel.connection.reconnect
      yield* channel.sendToQueue(queue, encode("new"))
      const current = yield* channel.get(queue)
      expect(Option.isSome(current)).toBe(true)
      if (Option.isNone(current)) return
      expectFailure(yield* channel.ack(old.value).pipe(Effect.exit), { _tag: "AMQPSettlementError", kind: "Stale" })
      yield* channel.nack(current.value, false, true)
      const redelivered = yield* channel.get(queue)
      expect(Option.isSome(redelivered)).toBe(true)
      if (Option.isSome(redelivered)) {
        expect(decode(redelivered.value.content)).toBe("new")
        expect(redelivered.value.fields.redelivered).toBe(true)
        yield* channel.ack(redelivered.value)
      }
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("restores named queues, exchange bindings and confirm mode", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const seed = yield* channel.assertQueue("", { exclusive: true })
      const queueName = `effect-native-${seed.queue}.named`
      const source = `effect-native-${seed.queue}.source`
      const target = `effect-native-${seed.queue}.target`
      yield* channel.assertExchange(source, "direct", { durable: false })
      yield* channel.assertExchange(target, "direct", { durable: false })
      const queue = yield* channel.assertQueue(queueName, { durable: false, exclusive: true })
      yield* Effect.addFinalizer(() =>
        Effect.all([
          channel.deleteExchange(source),
          channel.deleteExchange(target)
        ]).pipe(Effect.ignore)
      )
      yield* channel.bindExchange(target, source, "key")
      yield* channel.bindQueue(queue, target, "key")
      yield* channel.connection.reconnect
      expect(queue.queue).toBe(queueName)
      yield* channel.publish(source, "key", encode("restored"))
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isSome(message)) {
        expect(decode(message.value.content)).toBe("restored")
        yield* channel.ack(message.value)
      }
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))
})
