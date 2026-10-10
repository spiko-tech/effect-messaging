import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import { Buffer } from "node:buffer"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import { expectFailure } from "./assertions.ts"
import { decode, encode, testChannel, testConfirmChannel } from "./dependencies.ts"

describe("AMQPChannel", () => {
  it.live("publishes and assembles empty content without confusing the next message", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.sendToQueue(queue, new Uint8Array())
      yield* channel.sendToQueue(queue, encode("next"))
      const empty = yield* channel.get(queue)
      expect(Option.isSome(empty)).toBe(true)
      if (Option.isSome(empty)) {
        expect(empty.value.content).toEqual(new Uint8Array())
        yield* channel.ack(empty.value)
      }
      const next = yield* channel.get(queue)
      expect(Option.isSome(next)).toBe(true)
      if (Option.isSome(next)) {
        expect(decode(next.value.content)).toBe("next")
        yield* channel.ack(next.value)
      }
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("assembles interleaved multi-frame payloads on concurrent publishes", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const payloads = Array.from({ length: 4 }, (_, index) => {
        const bytes = new Uint8Array(300000)
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i + index) % 256
        return bytes
      })
      yield* Effect.forEach(payloads, (content, index) =>
        channel.sendToQueue(queue, content, { messageId: String(index) }), { concurrency: 4 })
      for (let i = 0; i < payloads.length; i++) {
        const result = yield* channel.get(queue)
        expect(Option.isSome(result)).toBe(true)
        if (Option.isSome(result)) {
          // Compare every byte without a deep matcher allocating entries for 300000 array elements.
          expect(Buffer.compare(result.value.content, payloads[Number(result.value.properties.messageId)])).toBe(0)
          yield* channel.ack(result.value)
        }
      }
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("exposes mandatory returns even when the broker confirms an unroutable publish", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const seed = yield* channel.assertQueue("", { exclusive: true })
      const returned = yield* channel.returns.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* channel.publish("", `effect-unroutable-${seed.queue}`, encode("unroutable"), { mandatory: true })
      const messages = yield* Fiber.join(returned)
      expect(messages).toHaveLength(1)
      expect(messages[0].fields.replyCode).toBe(312)
      expect(decode(messages[0].content)).toBe("unroutable")
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("declares, checks, purges and deletes queues", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      expect(queue.queue).not.toBe("")
      expect(yield* channel.checkQueue(queue)).toMatchObject({ queue: queue.queue, messageCount: 0 })
      expect(yield* channel.sendToQueue(queue, encode("one"))).toBeUndefined()
      yield* channel.sendToQueue(queue, encode("two"))
      expect(yield* channel.purgeQueue(queue)).toEqual({ messageCount: 2 })
      expect(yield* channel.get(queue)).toEqual(Option.none())
      expect(yield* channel.deleteQueue(queue)).toEqual({ messageCount: 0 })
    }).pipe(Effect.provide(testChannel)))

  it.live("gets bytes and properties, acknowledges once and rejects duplicate settlements", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.sendToQueue(queue, encode("payload"), {
        contentType: "text/plain",
        messageId: "message-1",
        headers: {
          nested: { flag: true },
          count: 42,
          maximum: BigInt("9223372036854775807"),
          minimum: BigInt("-9223372036854775808"),
          decimal: AMQPTypes.decimal(2, 4294967295)
        }
      })
      const result = yield* channel.get(queue)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isNone(result)) return
      expect(decode(result.value.content)).toBe("payload")
      expect(typeof result.value.fields.deliveryTag).toBe("bigint")
      expect(result.value.properties).toMatchObject({
        contentType: "text/plain",
        messageId: "message-1",
        headers: {
          nested: { flag: true },
          count: 42,
          maximum: BigInt("9223372036854775807"),
          minimum: BigInt("-9223372036854775808"),
          decimal: AMQPTypes.decimal(2, 4294967295)
        }
      })
      yield* channel.ack(result.value)
      expectFailure(yield* channel.ack(result.value).pipe(Effect.exit), {
        _tag: "AMQPSettlementError",
        kind: "AlreadySettled"
      })
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testChannel)))

  it.live("requeues nacks and rejects without requeue", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.sendToQueue(queue, encode("retry"))
      const first = yield* channel.get(queue)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first)) return
      yield* channel.nack(first.value, false, true)
      const second = yield* channel.get(queue)
      expect(Option.isSome(second)).toBe(true)
      if (Option.isNone(second)) return
      expect(second.value.fields.redelivered).toBe(true)
      yield* channel.reject(second.value, false)
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testChannel)))

  it.live("binds and unbinds queues and exchanges", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const source = `effect-native-${queue.queue}.source`
      const destination = `effect-native-${queue.queue}.destination`
      yield* channel.assertExchange(source, "direct", { durable: false })
      yield* channel.assertExchange(destination, "direct", { durable: false })
      yield* Effect.addFinalizer(() =>
        Effect.all([
          channel.deleteExchange(source),
          channel.deleteExchange(destination)
        ]).pipe(Effect.ignore)
      )
      yield* channel.checkExchange(source)
      yield* channel.bindExchange(destination, source, "key")
      yield* channel.bindQueue(queue, destination, "key")
      yield* channel.publish(source, "key", encode("routed"))
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isSome(message)) {
        expect(decode(message.value.content)).toBe("routed")
        yield* channel.ack(message.value)
      }
      yield* channel.unbindExchange(destination, source, "key")
      yield* channel.publish(source, "key", encode("not routed"))
      expect(yield* channel.get(queue)).toEqual(Option.none())
      yield* channel.unbindQueue(queue, destination, "key")
      yield* channel.publish(destination, "key", encode("also not routed"))
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(testChannel)))

  it.live("pipelines concurrent confirms and preserves every payload", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* Effect.forEach(Array.from({ length: 32 }, (_, i) => i), (i) =>
        channel.sendToQueue(queue, encode(`payload-${i}`)), { concurrency: 8 })
      const received = new Set<string>()
      for (let i = 0; i < 32; i++) {
        const result = yield* channel.get(queue)
        expect(Option.isSome(result)).toBe(true)
        if (Option.isSome(result)) {
          received.add(decode(result.value.content))
          yield* channel.ack(result.value)
        }
      }
      expect(received).toEqual(
        new Set(Array.from({ length: 32 }, (_, i) =>
          `payload-${i}`))
      )
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("reports broker nacks distinctly", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", {
        exclusive: true,
        arguments: { "x-max-length": 1, "x-overflow": "reject-publish" }
      })
      yield* channel.sendToQueue(queue, encode("first"))
      expectFailure(yield* channel.sendToQueue(queue, encode("second")).pipe(Effect.exit), {
        _tag: "AMQPPublishError",
        outcome: "Nacked"
      })
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("rejects invalid publish input as NotSent without poisoning subsequent confirms", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      expectFailure(yield* channel.publish("", "k".repeat(256), encode("invalid")).pipe(Effect.exit), {
        _tag: "AMQPPublishError",
        outcome: "NotSent"
      })
      yield* channel.sendToQueue(queue, encode("valid"))
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isSome(message)) yield* channel.ack(message.value)
    }).pipe(Effect.provide(testConfirmChannel)))
})
