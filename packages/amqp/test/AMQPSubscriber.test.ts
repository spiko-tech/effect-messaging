import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"
import { decode, encode, testConfirmChannel } from "./dependencies.ts"

const message = (deliveryTag: bigint, content = "payload"): AMQPConsumeMessage.AMQPConsumeMessage => ({
  content: encode(content),
  fields: { consumerTag: "test-consumer", deliveryTag, redelivered: false, exchange: "test", routingKey: "key" },
  properties: {}
})

// Public adapter boundary: missing operations fail loudly instead of mocking wire-engine internals.
const adapterFixture = Effect.fnUntraced(function*() {
  const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
  const settled = yield* Queue.unbounded<{
    readonly kind: "ack" | "nack" | "reject"
    readonly deliveryTag: bigint
    readonly requeue?: boolean | undefined
  }>()
  const cancelled = yield* Deferred.make<void>()
  const connection = yield* AMQPConnection.AMQPConnection.pipe(Effect.provide(Layer.mock(
    AMQPConnection.AMQPConnection,
    {
      [AMQPConnection.TypeId]: AMQPConnection.TypeId,
      serverProperties: Effect.succeed({ product: "RabbitMQ", hostname: "localhost", port: 5679 })
    }
  )))
  const layer = Layer.mock(AMQPChannel.AMQPChannel, {
    [AMQPChannel.TypeId]: AMQPChannel.TypeId,
    connection,
    consume: () =>
      Effect.succeed(
        Stream.fromQueue(deliveries).pipe(
          Stream.ensuring(Deferred.succeed(cancelled, undefined))
        )
      ),
    ack: (m) => Queue.offer(settled, { kind: "ack", deliveryTag: m.fields.deliveryTag }).pipe(Effect.asVoid),
    nack: (m, _allUpTo, requeue) =>
      Queue.offer(settled, {
        kind: "nack",
        deliveryTag: m.fields.deliveryTag,
        requeue
      }).pipe(Effect.asVoid),
    reject: (m, requeue) =>
      Queue.offer(settled, {
        kind: "reject",
        deliveryTag: m.fields.deliveryTag,
        requeue
      }).pipe(Effect.asVoid)
  })
  return { deliveries, settled, cancelled, layer }
})

describe("AMQPSubscriber", () => {
  it.effect("interrupts timed-out handlers and nacks without requeue", () =>
    Effect.gen(function*() {
      const fixture = yield* adapterFixture()
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const program = Effect.gen(function*() {
        const subscriber = yield* AMQPSubscriber.make("test", { handlerTimeout: "1 second" })
        return yield* subscriber.subscribe(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
          )
        )
      })
      const fiber = yield* program.pipe(Effect.provide(fixture.layer), Effect.forkChild)
      yield* Queue.offer(fixture.deliveries, message(1n))
      yield* Deferred.await(started)
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(interrupted)
      expect(yield* Queue.take(fixture.settled)).toEqual({ kind: "nack", deliveryTag: 1n, requeue: false })
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("cancels consumption before draining an in-flight uninterruptible handler", () =>
    Effect.gen(function*() {
      const fixture = yield* adapterFixture()
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const program = Effect.gen(function*() {
        const subscriber = yield* AMQPSubscriber.make("test", { handlerTimeout: "10 seconds" })
        return yield* subscriber.subscribe(Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(finish)
          return AMQPSubscriberResponse.ack()
        }))
      })
      const fiber = yield* program.pipe(Effect.provide(fixture.layer), Effect.forkChild)
      yield* Queue.offer(fixture.deliveries, message(1n))
      yield* Deferred.await(started)
      const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* Deferred.await(fixture.cancelled)
      expect(yield* Deferred.isDone(finish)).toBe(false)
      yield* Queue.offer(fixture.deliveries, message(2n))
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(interrupting)
      expect(yield* Queue.take(fixture.settled)).toEqual({ kind: "ack", deliveryTag: 1n })
      expect(yield* Queue.size(fixture.deliveries)).toBe(1)
    }))

  it.effect("bounds active handlers by concurrency instead of spawning unbounded fibers", () =>
    Effect.gen(function*() {
      const fixture = yield* adapterFixture()
      const started = yield* Queue.unbounded<bigint>()
      const permits = yield* Queue.unbounded<void>()
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const program = Effect.gen(function*() {
        const subscriber = yield* AMQPSubscriber.make("test", { concurrency: 2 })
        return yield* subscriber.subscribe(Effect.gen(function*() {
          const m = yield* AMQPConsumeMessage.AMQPConsumeMessage
          const count = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (n) => Math.max(n, count))
          yield* Queue.offer(started, m.fields.deliveryTag)
          yield* Queue.take(permits)
          yield* Ref.update(active, (n) => n - 1)
          return AMQPSubscriberResponse.ack()
        }))
      })
      const fiber = yield* program.pipe(Effect.provide(fixture.layer), Effect.forkChild)
      for (let i = 1; i <= 6; i++) yield* Queue.offer(fixture.deliveries, message(BigInt(i)))
      for (let batch = 0; batch < 3; batch++) {
        yield* Queue.take(started)
        yield* Queue.take(started)
        expect(yield* Ref.get(active)).toBe(2)
        yield* Queue.offer(permits, undefined)
        yield* Queue.offer(permits, undefined)
        yield* Queue.take(fixture.settled)
        yield* Queue.take(fixture.settled)
      }
      yield* Fiber.interrupt(fiber)
      expect(yield* Ref.get(peak)).toBe(2)
    }))

  it.effect("maps explicit ack, nack and reject responses to settlements", () =>
    Effect.gen(function*() {
      const fixture = yield* adapterFixture()
      const program = Effect.gen(function*() {
        const subscriber = yield* AMQPSubscriber.make("test", { concurrency: 1 })
        return yield* subscriber.subscribe(Effect.gen(function*() {
          const m = yield* AMQPConsumeMessage.AMQPConsumeMessage
          if (m.fields.deliveryTag === 1n) return AMQPSubscriberResponse.ack()
          if (m.fields.deliveryTag === 2n) return AMQPSubscriberResponse.nack({ requeue: true })
          return AMQPSubscriberResponse.reject({ requeue: false })
        }))
      })
      const fiber = yield* program.pipe(Effect.provide(fixture.layer), Effect.forkChild)
      for (let i = 1; i <= 3; i++) yield* Queue.offer(fixture.deliveries, message(BigInt(i)))
      expect(yield* Queue.take(fixture.settled)).toEqual({ kind: "ack", deliveryTag: 1n })
      expect(yield* Queue.take(fixture.settled)).toEqual({ kind: "nack", deliveryTag: 2n, requeue: true })
      expect(yield* Queue.take(fixture.settled)).toEqual({ kind: "reject", deliveryTag: 3n, requeue: false })
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("uses propagated trace context as the handler span parent", () =>
    Effect.gen(function*() {
      const fixture = yield* adapterFixture()
      const observed = yield* Deferred.make<{ readonly traceId: string; readonly parentId?: string | undefined }>()
      const traceId = "0123456789abcdef0123456789abcdef"
      const parentId = "0123456789abcdef"
      const program = Effect.gen(function*() {
        const subscriber = yield* AMQPSubscriber.make("test", { producerSpanRelation: "parent" })
        return yield* subscriber.subscribe(Effect.gen(function*() {
          const span = yield* Effect.currentSpan
          yield* Deferred.succeed(observed, {
            traceId: span.traceId,
            parentId: Option.isSome(span.parent) ? span.parent.value.spanId : undefined
          })
          return AMQPSubscriberResponse.ack()
        }))
      })
      const fiber = yield* program.pipe(Effect.provide(fixture.layer), Effect.forkChild)
      yield* Queue.offer(fixture.deliveries, {
        ...message(1n),
        properties: { headers: { traceparent: `00-${traceId}-${parentId}-01` } }
      })
      expect(yield* Deferred.await(observed)).toEqual({ traceId, parentId })
      yield* Queue.take(fixture.settled)
      yield* Fiber.interrupt(fiber)
    }))

  it.live("consumes and acknowledges published bytes across connection recovery", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const named = yield* channel.assertQueue(`effect-native-${queue.queue}.subscriber`, { exclusive: true })
      const subscriber = yield* AMQPSubscriber.make(named, { concurrency: 1 })
      const received = yield* Queue.unbounded<string>()
      const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
        const m = yield* AMQPConsumeMessage.AMQPConsumeMessage
        yield* Queue.offer(received, decode(m.content))
        return AMQPSubscriberResponse.ack()
      })).pipe(Effect.forkChild)
      yield* channel.sendToQueue(named, encode("before"))
      expect(yield* Queue.take(received)).toBe("before")
      yield* channel.connection.reconnect
      yield* channel.sendToQueue(named, encode("after"))
      expect(yield* Queue.take(received)).toBe("after")
      yield* Fiber.interrupt(fiber)
      expect((yield* channel.checkQueue(named)).consumerCount).toBe(0)
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("cancels one subscriber without disrupting another on a shared channel", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const a = yield* channel.assertQueue("", { exclusive: true })
      const b = yield* channel.assertQueue("", { exclusive: true })
      const received = yield* Queue.unbounded<string>()
      const handler = Effect.gen(function*() {
        const m = yield* AMQPConsumeMessage.AMQPConsumeMessage
        yield* Queue.offer(received, decode(m.content))
        return AMQPSubscriberResponse.ack()
      })
      const subscriberA = yield* AMQPSubscriber.make(a.queue)
      const subscriberB = yield* AMQPSubscriber.make(b.queue)
      const fiberA = yield* subscriberA.subscribe(handler).pipe(Effect.forkChild)
      const fiberB = yield* subscriberB.subscribe(handler).pipe(Effect.forkChild)
      yield* channel.sendToQueue(a, encode("a-ready"))
      expect(yield* Queue.take(received)).toBe("a-ready")
      yield* channel.sendToQueue(b, encode("b-ready"))
      expect(yield* Queue.take(received)).toBe("b-ready")
      yield* Fiber.interrupt(fiberA)
      expect((yield* channel.checkQueue(a)).consumerCount).toBe(0)
      expect((yield* channel.checkQueue(b)).consumerCount).toBe(1)
      yield* channel.sendToQueue(a, encode("left-for-next"))
      yield* channel.sendToQueue(b, encode("still-active"))
      expect(yield* Queue.take(received)).toBe("still-active")
      const pending = yield* channel.get(a)
      expect(Option.isSome(pending)).toBe(true)
      if (Option.isSome(pending)) {
        expect(decode(pending.value.content)).toBe("left-for-next")
        yield* channel.ack(pending.value)
      }
      yield* Fiber.interrupt(fiberB)
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live(
    "keeps concurrency permits across reconnect while old handlers are still in flight",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const seed = yield* channel.assertQueue("", { exclusive: true })
        const queue = yield* channel.assertQueue(`effect-native-${seed.queue}.permits`, { exclusive: true })
        const started = yield* Queue.unbounded<string>()
        const permits = yield* Queue.unbounded<void>()
        const active = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const subscriber = yield* AMQPSubscriber.make(queue.queue, { concurrency: 2 })
        const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
          const m = yield* AMQPConsumeMessage.AMQPConsumeMessage
          const count = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (n) => Math.max(n, count))
          yield* Queue.offer(started, decode(m.content))
          yield* Queue.take(permits)
          yield* Ref.update(active, (n) => n - 1)
          return AMQPSubscriberResponse.ack()
        })).pipe(Effect.forkChild)
        yield* channel.sendToQueue(queue, encode("old-1"))
        yield* channel.sendToQueue(queue, encode("old-2"))
        expect(new Set([yield* Queue.take(started), yield* Queue.take(started)])).toEqual(new Set(["old-1", "old-2"]))
        yield* channel.connection.reconnect
        yield* channel.sendToQueue(queue, encode("new-1"))
        yield* channel.sendToQueue(queue, encode("new-2"))
        yield* Queue.offer(permits, undefined)
        yield* Queue.offer(permits, undefined)
        expect(new Set([yield* Queue.take(started), yield* Queue.take(started)])).toEqual(new Set(["new-1", "new-2"]))
        yield* Queue.offer(permits, undefined)
        yield* Queue.offer(permits, undefined)
        yield* Fiber.interrupt(fiber)
        expect(yield* Ref.get(peak)).toBe(2)
        expect(yield* Ref.get(active)).toBe(0)
      }).pipe(Effect.provide(testConfirmChannel)),
    { timeout: 15000 }
  )
})
