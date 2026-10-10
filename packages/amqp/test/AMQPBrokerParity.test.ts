import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { randomUUID } from "node:crypto"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import { expectFailure } from "./assertions.ts"
import { decode, encode, testConfirmChannel } from "./dependencies.ts"

describe("AMQP real broker parity", () => {
  it.live(
    "confirms 100000 bounded concurrent publishes without missing or duplicate payloads",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const payloads = Array.from({ length: 100000 }, (_, index) => ({
          id: String(index),
          content: encode(`parity-${index}:${"bounded-confirm-payload".repeat(8)}`)
        }))
        const expected = new Map(payloads.map((message) => [message.id, message.content]))
        const received = new Set<string>()
        const stream = yield* channel.consume(queue, { prefetch: 64 })
        const consuming = yield* stream.pipe(
          Stream.take(100000),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              const id = message.properties.messageId
              expect(id).toBeDefined()
              if (id === undefined) return
              expect(expected.has(id)).toBe(true)
              expect(received.has(id)).toBe(false)
              expect(message.content).toEqual(expected.get(id))
              received.add(id)
              yield* channel.ack(message)
            })
          ),
          Effect.forkChild
        )
        yield* Effect.forEach(
          payloads,
          (message) => channel.sendToQueue(queue, message.content, { messageId: message.id }),
          { concurrency: 32, discard: true }
        )
        yield* Fiber.join(consuming)
        expect(received.size).toBe(100000)
        expect(received).toEqual(new Set(expected.keys()))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.provide(testConfirmChannel)),
    120000
  )

  for (const reason of ["expired", "rejected"]) {
    it.live(`a classic queue dead-letters ${reason} messages with broker death metadata`, () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const destination = yield* channel.assertQueue("", {
          exclusive: true,
          arguments: { "x-queue-type": "classic" }
        })
        const source = yield* channel.assertQueue("", {
          exclusive: true,
          arguments: {
            "x-queue-type": "classic",
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": destination.queue,
            ...(reason === "expired" ? { "x-message-ttl": 50 } : {})
          }
        })
        const stream = yield* channel.consume(destination)
        const receiving = yield* stream.pipe(
          Stream.take(1),
          Stream.mapEffect((message) => channel.ack(message).pipe(Effect.as(message))),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* channel.sendToQueue(source, encode(`dead-letter-${reason}`), { messageId: `dlx-${reason}` })
        if (reason === "rejected") {
          const original = yield* channel.get(source)
          expect(Option.isSome(original)).toBe(true)
          if (Option.isNone(original)) return
          yield* channel.reject(original.value, false)
        }
        // The broker delivery, rather than elapsed time or polling, signals TTL completion.
        const [message] = yield* Fiber.join(receiving)
        expect(decode(message.content)).toBe(`dead-letter-${reason}`)
        expect(message.properties.messageId).toBe(`dlx-${reason}`)
        expect(message.fields.routingKey).toBe(destination.queue)
        expect(message.properties.headers?.["x-death"]).toEqual([
          expect.objectContaining({ reason, queue: source.queue, exchange: "" })
        ])
        expect(yield* channel.get(source)).toEqual(Option.none())
        expect(yield* channel.get(destination)).toEqual(Option.none())
      }).pipe(Effect.provide(testConfirmChannel)), 15000)
  }

  it.live(
    "a durable quorum queue confirms persistent messages and redelivers rejected deliveries",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const cleanup = yield* channel.connection.createChannel()
        const name = `effect-parity-quorum-${randomUUID()}`
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
        const queue = yield* channel.assertQueue(name, {
          durable: true,
          arguments: { "x-queue-type": "quorum" }
        })
        yield* channel.sendToQueue(queue, encode("quorum-persistent"), { persistent: true, messageId: "quorum-1" })
        const original = yield* channel.get(queue)
        expect(Option.isSome(original)).toBe(true)
        if (Option.isNone(original)) return
        expect(original.value.properties.deliveryMode).toBe(2)
        expect(original.value.fields.redelivered).toBe(false)
        yield* channel.reject(original.value, true)
        const redelivered = yield* channel.get(queue)
        expect(Option.isSome(redelivered)).toBe(true)
        if (Option.isNone(redelivered)) return
        expect(decode(redelivered.value.content)).toBe("quorum-persistent")
        expect(redelivered.value.properties.messageId).toBe("quorum-1")
        expect(redelivered.value.fields.redelivered).toBe(true)
        yield* channel.ack(redelivered.value)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
    15000
  )

  it.live(
    "headers routing preserves explicit integral float and double values through republish",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const cleanup = yield* channel.connection.createChannel()
        const exchange = `effect-parity-${randomUUID()}`
        yield* Effect.addFinalizer(() => cleanup.deleteExchange(exchange).pipe(Effect.ignore))
        yield* channel.assertExchange(exchange, "headers", { durable: false })
        const source = yield* channel.assertQueue("", { exclusive: true })
        const routed = yield* channel.assertQueue("", { exclusive: true })
        const headers = {
          route: "typed",
          float: AMQPTypes.fieldNumber("float", 7),
          double: AMQPTypes.fieldNumber("double", 11),
          decimal: AMQPTypes.decimal(2, 1234)
        }
        yield* channel.bindQueue(routed, exchange, "", {
          "x-match": "all",
          route: "typed",
          float: headers.float,
          double: headers.double
        })
        yield* channel.sendToQueue(source, encode("typed-headers"), { headers })
        const received = yield* channel.get(source)
        expect(Option.isSome(received)).toBe(true)
        if (Option.isNone(received)) return
        expect(received.value.properties.headers).toEqual(headers)
        yield* channel.publish(exchange, "", received.value.content, received.value.properties)
        yield* channel.ack(received.value)
        const republished = yield* channel.get(routed)
        expect(Option.isSome(republished)).toBe(true)
        if (Option.isNone(republished)) return
        expect(decode(republished.value.content)).toBe("typed-headers")
        expect(republished.value.properties.headers).toEqual(headers)
        yield* channel.ack(republished.value)
        yield* channel.publish(exchange, "", encode("wrong-route"), { headers: { ...headers, route: "other" } })
        expect(yield* channel.get(routed)).toEqual(Option.none())
        yield* channel.publish(exchange, "", encode("integer-not-double"), { headers: { ...headers, double: 11 } })
        expect(yield* channel.get(routed)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
    15000
  )

  it.live(
    "a mismatched exchange reassert reports 406 and restores its original bindings",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const cleanup = yield* channel.connection.createChannel()
        const exchange = `effect-parity-${randomUUID()}`
        yield* Effect.addFinalizer(() => cleanup.deleteExchange(exchange).pipe(Effect.ignore))
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.assertExchange(exchange, "direct", { durable: false })
        yield* channel.bindQueue(queue, exchange, "key")
        expectFailure(yield* channel.assertExchange(exchange, "fanout", { durable: false }).pipe(Effect.exit), {
          _tag: "AMQPChannelError",
          replyCode: 406,
          classId: 40,
          methodId: 10
        })
        yield* channel.publish(exchange, "key", encode("after-exchange-error"))
        const received = yield* channel.get(queue)
        expect(Option.isSome(received)).toBe(true)
        if (Option.isNone(received)) return
        expect(decode(received.value.content)).toBe("after-exchange-error")
        yield* channel.ack(received.value)
        yield* channel.publish(exchange, "other-key", encode("must-not-route"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
    15000
  )

  it.live("a mismatched queue reassert reports 406 and recovers the logical channel", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const cleanup = yield* channel.connection.createChannel()
      const name = `effect-parity-${randomUUID()}`
      yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
      const queue = yield* channel.assertQueue(name, { durable: true, autoDelete: false })
      expectFailure(yield* channel.assertQueue(name, { durable: true, autoDelete: true }).pipe(Effect.exit), {
        _tag: "AMQPChannelError",
        replyCode: 406,
        classId: 50,
        methodId: 10
      })
      yield* channel.sendToQueue(queue, encode("after-queue-error"))
      const received = yield* channel.get(queue)
      expect(Option.isSome(received)).toBe(true)
      if (Option.isNone(received)) return
      expect(decode(received.value.content)).toBe("after-queue-error")
      yield* channel.ack(received.value)
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)), 15000)

  it.live(
    "returns a zero-length mandatory publish without consuming the following content",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const seed = yield* channel.assertQueue("", { exclusive: true })
        const routingKey = `missing-${seed.queue}`
        const receiving = yield* channel.returns.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* channel.publish("", routingKey, new Uint8Array(), { mandatory: true, messageId: "empty" })
        yield* channel.publish("", routingKey, encode("following"), { mandatory: true, messageId: "next" })
        const returned = yield* Fiber.join(receiving)
        expect(returned).toHaveLength(2)
        expect(returned[0].fields).toMatchObject({ replyCode: 312, exchange: "", routingKey })
        expect(returned[0].properties.messageId).toBe("empty")
        expect(returned[0].content).toEqual(new Uint8Array())
        expect(returned[1].properties.messageId).toBe("next")
        expect(decode(returned[1].content)).toBe("following")
      }).pipe(Effect.provide(testConfirmChannel)),
    15000
  )

  it.live(
    "queue deletion cancels only its consumer and leaves the logical channel usable",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const removed = yield* channel.assertQueue("", { exclusive: true })
        const retained = yield* channel.assertQueue("", { exclusive: true })
        const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const removedStream = yield* channel.consume(removed)
        const cancelled = yield* removedStream.pipe(
          Stream.runForEach((message) => channel.ack(message).pipe(Effect.andThen(Queue.offer(deliveries, message)))),
          Effect.exit,
          Effect.forkChild
        )
        const retainedStream = yield* channel.consume(retained)
        yield* retainedStream.pipe(
          Stream.runForEach((message) => channel.ack(message).pipe(Effect.andThen(Queue.offer(deliveries, message)))),
          Effect.forkChild
        )
        // Observing both deliveries proves that both broker registrations are active.
        yield* channel.sendToQueue(removed, encode("removed-ready"))
        expect(decode((yield* Queue.take(deliveries)).content)).toBe("removed-ready")
        yield* channel.sendToQueue(retained, encode("retained-ready"))
        expect(decode((yield* Queue.take(deliveries)).content)).toBe("retained-ready")
        yield* channel.deleteQueue(removed)
        expectFailure(yield* Fiber.join(cancelled), { _tag: "AMQPChannelError" })
        yield* channel.sendToQueue(retained, encode("still-usable"))
        expect(decode((yield* Queue.take(deliveries)).content)).toBe("still-usable")
        expect((yield* channel.checkQueue(retained)).consumerCount).toBe(1)
        expect((yield* channel.connection.state).state).toBe("Ready")
      }).pipe(Effect.provide(testConfirmChannel)),
    15000
  )

  it.live("basic.recover requeues deliveries and makes original settlements stale", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const stream = yield* channel.consume(queue, { prefetch: 1 })
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(deliveries, message)), Effect.forkChild)
      yield* channel.sendToQueue(queue, encode("recover-me"))
      const original = yield* Queue.take(deliveries)
      expect(original.fields.redelivered).toBe(false)
      yield* channel.recover()
      const redelivered = yield* Queue.take(deliveries)
      expect(decode(redelivered.content)).toBe("recover-me")
      expect(redelivered.fields.redelivered).toBe(true)
      expectFailure(yield* channel.ack(original).pipe(Effect.exit), {
        _tag: "AMQPSettlementError",
        kind: "Stale"
      })
      yield* channel.ack(redelivered)
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testConfirmChannel)), 15000)

  it.live("a multiple acknowledgement settles only its delivery prefix", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const deliveries: Array<AMQPConsumeMessage.AMQPConsumeMessage> = []
      for (const content of ["one", "two", "three"]) yield* channel.sendToQueue(queue, encode(content))
      for (let i = 0; i < 3; i++) {
        const delivery = yield* channel.get(queue)
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isSome(delivery)) deliveries.push(delivery.value)
      }
      expect(deliveries).toHaveLength(3)
      yield* channel.ack(deliveries[1], true)
      expectFailure(yield* channel.ack(deliveries[0]).pipe(Effect.exit), {
        _tag: "AMQPSettlementError",
        kind: "AlreadySettled"
      })
      yield* channel.ack(deliveries[2])
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("nackAll requeues every outstanding delivery and ackAll settles the redeliveries", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      for (const content of ["one", "two", "three"]) yield* channel.sendToQueue(queue, encode(content))
      for (let i = 0; i < 3; i++) expect(Option.isSome(yield* channel.get(queue))).toBe(true)
      yield* channel.nackAll(true)
      const received = new Set<string>()
      for (let i = 0; i < 3; i++) {
        const delivery = yield* channel.get(queue)
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isSome(delivery)) {
          expect(delivery.value.fields.redelivered).toBe(true)
          received.add(decode(delivery.value.content))
        }
      }
      expect(received).toEqual(new Set(["one", "two", "three"]))
      yield* channel.ackAll()
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live(
    "restores a real auto-delete queue owned by another channel after its only consumer channel fails",
    () =>
      Effect.gen(function*() {
        const owner = yield* AMQPChannel.AMQPChannel
        const connection = owner.connection
        const consumer = yield* connection.createChannel()
        const cleanup = yield* connection.createChannel()
        const name = `effect-parity-auto-delete-${randomUUID()}`
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
        const queue = yield* owner.assertQueue(name, { durable: true, autoDelete: true })
        const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const stream = yield* consumer.consume(queue)
        yield* stream.pipe(
          Stream.runForEach((message) => consumer.ack(message).pipe(Effect.andThen(Queue.offer(deliveries, message)))),
          Effect.forkChild
        )
        yield* owner.sendToQueue(queue, encode("before-channel-error"))
        expect(decode((yield* Queue.take(deliveries)).content)).toBe("before-channel-error")
        const generation = (yield* connection.state).generation
        expectFailure(yield* consumer.checkQueue(`missing-${randomUUID()}`).pipe(Effect.exit), {
          _tag: "AMQPChannelError",
          replyCode: 404
        })
        yield* connection.awaitReady
        yield* owner.sendToQueue(queue, encode("after-channel-error"))
        expect(decode((yield* Queue.take(deliveries)).content)).toBe("after-channel-error")
        expect((yield* connection.state).generation).toBeGreaterThan(generation)
        expect((yield* owner.checkQueue(queue)).consumerCount).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)),
    15000
  )
})
