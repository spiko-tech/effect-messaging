import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Schedule, Stream } from "effect"
import * as Crypto from "node:crypto"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"
import { expectFailure } from "./assertions.ts"

// Reference noAck and callback/helper facades are intentionally unsupported.
// These scenarios exercise their supported manual-settlement/Stream counterparts only.
import { broker, decode, encode } from "./dependencies.ts"

const fixture = Effect.fnUntraced(function*(prefetch = 1) {
  const connection = yield* AMQPNodeConnection.make({ ...broker, channelMax: 4 })
  const cleanup = yield* connection.createChannel()
  const channel = yield* connection.createChannel({ confirm: true, prefetch })
  const queue = yield* channel.assertQueue(`consumer-parity-${Crypto.randomUUID()}`, { durable: true })
  yield* Effect.addFinalizer(() => cleanup.deleteQueue(queue).pipe(Effect.orDie))
  return { connection, channel, queue, cleanup }
})

const receive = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  queue: string,
  options: { readonly prefetch?: number; readonly exclusive?: boolean; readonly consumerTag?: string } = {}
) {
  const inbox = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
  const stream = yield* channel.consume(queue, options)
  const fiber = yield* stream.pipe(Stream.runForEach((m) => Queue.offer(inbox, m)), Effect.forkScoped)
  return { inbox, fiber }
})

// Keep unrelated broker stress workloads from competing; each retains its own concurrent protocol operations.
describe("AMQP supported consumer scenario parity", { concurrent: false }, () => {
  it.live("R-C05 native policy: actual subscriber prefetch one keeps blue and green queued during channel recovery", () =>
    Effect.gen(function*() {
      const { channel, queue } = yield* fixture(3)
      const started = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const permits = yield* Queue.unbounded<void>()
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const subscriber = yield* AMQPSubscriber.make(queue, { concurrency: 1 })
        .pipe(Effect.provideService(AMQPChannel.AMQPChannel, channel))
      const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
        const count = yield* Ref.updateAndGet(active, (n) => n + 1)
        yield* Ref.update(peak, (n) => Math.max(n, count))
        yield* Queue.offer(started, message)
        yield* Queue.take(permits)
        yield* Ref.update(active, (n) => n - 1)
        return AMQPSubscriberResponse.ack()
      })).pipe(Effect.forkScoped)
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          Array.from({ length: 10 }),
          () => Queue.offer(permits, undefined),
          { discard: true }
        )
      )
      yield* channel.sendToQueue(queue, encode("red"))
      const red = yield* Queue.take(started)
      expect(decode(red.content)).toBe("red")
      expect(red.fields.redelivered).toBe(false)
      // Native policy couples per-consumer prefetch to concurrency. Unlike the reference, neither next
      // message is delivered/buffered while red is held; changing QoS would not change existing consumer credit.
      yield* channel.sendToQueue(queue, encode("blue"))
      yield* channel.sendToQueue(queue, encode("green"))
      expect((yield* channel.checkQueue(queue)).messageCount).toBe(2)
      expectFailure(yield* channel.checkQueue(`missing-${Crypto.randomUUID()}`).pipe(Effect.exit), {
        _tag: "AMQPChannelError",
        replyCode: 404
      })
      yield* channel.checkQueue(queue)
      expect(yield* Ref.get(active)).toBe(1)
      expect(yield* Queue.size(started)).toBe(0)
      yield* Queue.offer(permits, undefined)
      for (const expected of ["red", "blue", "green"]) {
        const redelivery = yield* Queue.take(started)
        expect(decode(redelivery.content)).toBe(expected)
        expect(redelivery.fields.redelivered).toBe(expected === "red")
        yield* Queue.offer(permits, undefined)
      }
      yield* Fiber.interrupt(fiber)
      expect(yield* Ref.get(peak)).toBe(1)
      expect(yield* Ref.get(active)).toBe(0)
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live(
    "R-C02: actual topic subscriber requeues explicitly, recovers channel and connection, then fails on queue deletion without recreation",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup, connection, queue } = yield* fixture()
        const exchange = `subscriber-journey-${Crypto.randomUUID()}`
        yield* channel.assertExchange(exchange, "topic", { durable: true })
        yield* Effect.addFinalizer(() => cleanup.deleteExchange(exchange).pipe(Effect.orDie))
        yield* channel.bindQueue(queue, exchange, "events.#")
        const started = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const permits = yield* Queue.unbounded<void>()
        const subscriber = yield* AMQPSubscriber.make(queue, { concurrency: 1 })
          .pipe(Effect.provideService(AMQPChannel.AMQPChannel, channel))
        const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          yield* Queue.offer(started, message)
          yield* Queue.take(permits)
          return decode(message.content) === "explicit requeue" && !message.fields.redelivered
            ? AMQPSubscriberResponse.nack({ requeue: true })
            : AMQPSubscriberResponse.ack()
        })).pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            Array.from({ length: 10 }),
            () => Queue.offer(permits, undefined),
            { discard: true }
          )
        )
        const body = encode("explicit requeue")
        yield* channel.publish(exchange, "events.created", body)
        yield* channel.publish(exchange, "other.created", encode("excluded topic"))
        const first = yield* Queue.take(started)
        expect(first.content).toEqual(body)
        expect(first.fields).toMatchObject({ exchange, routingKey: "events.created", redelivered: false })
        yield* Queue.offer(permits, undefined)
        const requeued = yield* Queue.take(started)
        expect(requeued.content).toEqual(body)
        expect(requeued.fields.redelivered).toBe(true)
        yield* channel.publish(exchange, "events.channel", encode("channel recovery"))
        yield* Queue.offer(permits, undefined)
        const beforeError = yield* Queue.take(started)
        expect(decode(beforeError.content)).toBe("channel recovery")
        expect(beforeError.fields.redelivered).toBe(false)
        expectFailure(yield* channel.checkQueue(`missing-${Crypto.randomUUID()}`).pipe(Effect.exit), {
          _tag: "AMQPChannelError",
          replyCode: 404
        })
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
        yield* Queue.offer(permits, undefined)
        const afterError = yield* Queue.take(started)
        expect(afterError.content).toEqual(beforeError.content)
        expect(afterError.fields.redelivered).toBe(true)
        yield* channel.publish(exchange, "events.connection", encode("connection recovery"))
        yield* Queue.offer(permits, undefined)
        const beforeReconnect = yield* Queue.take(started)
        expect(decode(beforeReconnect.content)).toBe("connection recovery")
        yield* connection.reconnect
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
        yield* Queue.offer(permits, undefined)
        const afterReconnect = yield* Queue.take(started)
        expect(afterReconnect.content).toEqual(beforeReconnect.content)
        expect(afterReconnect.fields.redelivered).toBe(true)
        yield* channel.publish(exchange, "events.after", encode("after recovery"))
        yield* Queue.offer(permits, undefined)
        const afterRecovery = yield* Queue.take(started)
        expect(decode(afterRecovery.content)).toBe("after recovery")
        expect(afterRecovery.fields.redelivered).toBe(false)
        yield* cleanup.deleteQueue(queue)
        yield* Queue.offer(permits, undefined)
        const outcome = yield* Fiber.join(fiber)
        expectFailure(outcome, {
          _tag: "SubscriberError",
          cause: expect.objectContaining({
            _tag: "AMQPChannelError",
            reason: expect.stringContaining("Broker cancelled consumer")
          })
        })
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* Queue.size(started)).toBe(0)
        expectFailure(yield* cleanup.checkQueue(queue).pipe(Effect.exit), {
          _tag: "AMQPChannelError",
          replyCode: 404
        })
        yield* connection.reconnect
        expectFailure(yield* cleanup.checkQueue(queue).pipe(Effect.exit), {
          _tag: "AMQPChannelError",
          replyCode: 404
        })
      }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
    { timeout: 20000 }
  )

  it.live(
    "C-T64: same-channel consumer concurrently republishes twice with confirms and ack through delivery tag 10000",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup, queue } = yield* fixture()
        const body = encode("x".repeat(500))
        const tags = new Set<bigint>()
        yield* channel.sendToQueue(queue, body)
        const stream = yield* channel.consume(queue, { prefetch: 1 })
        yield* stream.pipe(
          Stream.take(10000),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              expect(message.content).toEqual(body)
              expect(message.fields.redelivered).toBe(false)
              expect(tags.has(message.fields.deliveryTag)).toBe(false)
              tags.add(message.fields.deliveryTag)
              expect(message.fields.deliveryTag).toBe(BigInt(tags.size))
              if (message.fields.deliveryTag < 10000n) {
                yield* Effect.all([
                  channel.sendToQueue(queue, message.content),
                  channel.sendToQueue(queue, message.content),
                  channel.ack(message)
                ], { concurrency: 3 })
              } else {
                yield* channel.ack(message)
              }
            })
          )
        )
        expect(tags.size).toBe(10000)
        // Closing fences any extra delivery admitted between the target ack and consumer cancellation.
        // An inspector on another channel then counts ready messages, not a still-unacked tail delivery.
        yield* channel.close
        const remaining = yield* cleanup.checkQueue(queue)
        expect(remaining.consumerCount).toBe(0)
        expect(remaining.messageCount).toBe(9999)
      }).pipe(Effect.scoped, Effect.timeout("110 seconds")),
    { timeout: 120000 }
  )

  it.live(
    "C-T55: preloads 100000 five-byte messages sequentially before manual consumer drain with frameMax 8192",
    () =>
      Effect.gen(function*() {
        const connection = yield* AMQPNodeConnection.make({ ...broker, frameMax: 8192 })
        const channel = yield* connection.createChannel()
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const body = encode("aaaaa")
        for (let i = 0; i < 100000; i++) yield* channel.sendToQueue(queue, body)
        // Non-confirm publishes route asynchronously inside RabbitMQ. An ordered channel RPC alone
        // is not a queue-process receipt barrier; require the exact backlog before starting consumption.
        const preloaded = yield* channel.checkQueue(queue).pipe(Effect.repeat({
          schedule: Schedule.spaced("1 millis"),
          until: (reply) => reply.messageCount === 100000
        }))
        expect(preloaded.messageCount).toBe(100000)
        expect(preloaded.consumerCount).toBe(0)
        const stream = yield* channel.consume(queue, { prefetch: 256 })
        let count = 0
        yield* stream.pipe(
          Stream.take(100000),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              expect(message.content).toEqual(body)
              expect(message.fields.deliveryTag).toBe(BigInt(++count))
              yield* channel.ack(message)
            })
          )
        )
        expect(count).toBe(100000)
        const drained = yield* channel.checkQueue(queue)
        expect(drained.messageCount).toBe(0)
        expect(drained.consumerCount).toBe(0)
      }).pipe(Effect.scoped, Effect.timeout("110 seconds")),
    { timeout: 120000 }
  )

  it.live(
    "C-T59: healthy real broker heartbeats maintain Ready and the same generation across multiple idle intervals",
    () =>
      Effect.gen(function*() {
        const connection = yield* AMQPNodeConnection.make({
          ...broker,
          heartbeat: 1,
          retryConnectionSchedule: Schedule.recurs(0)
        })
        const initial = yield* connection.state
        expect(initial.state).toBe("Ready")
        // This idle interval is the behavior under test: no application traffic may mask heartbeat liveness.
        yield* Effect.sleep("3 seconds")
        expect(yield* connection.state).toMatchObject({ state: "Ready", generation: initial.generation })
        const channel = yield* connection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.sendToQueue(queue, encode("after healthy idle heartbeats"))
        const message = yield* channel.get(queue)
        expect(Option.isSome(message)).toBe(true)
        if (Option.isSome(message)) {
          expect(decode(message.value.content)).toBe("after healthy idle heartbeats")
          yield* channel.ack(message.value)
        }
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    { timeout: 15000 }
  )

  it.live("CA26: default single ack settles only its delivery and preserves the other original", () =>
    Effect.gen(function*() {
      const { channel, queue } = yield* fixture(2)
      yield* channel.sendToQueue(queue, encode("first"))
      yield* channel.sendToQueue(queue, encode("second"))
      const consumer = yield* receive(channel, queue.queue, { prefetch: 2 })
      const first = yield* Queue.take(consumer.inbox)
      const second = yield* Queue.take(consumer.inbox)
      expect([decode(first.content), decode(second.content)]).toEqual(["first", "second"])
      yield* channel.ack(first)
      yield* channel.recover()
      const redelivery = yield* Queue.take(consumer.inbox)
      expect(redelivery.content).toEqual(second.content)
      expect(redelivery.fields.redelivered).toBe(true)
      yield* channel.ack(redelivery)
      yield* Fiber.interrupt(consumer.fiber)
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  for (const settlement of ["nack", "reject"] as const) {
    it.live(`${settlement === "nack" ? "CA27" : "CA28"}: omitted ${settlement} defaults requeue identical bytes`, () =>
      Effect.gen(function*() {
        const { channel, queue } = yield* fixture()
        const body = new Uint8Array([0, 255, 128, 42])
        yield* channel.sendToQueue(queue, body)
        const consumer = yield* receive(channel, queue.queue)
        const original = yield* Queue.take(consumer.inbox)
        expect(original.fields.redelivered).toBe(false)
        yield* channel[settlement](original)
        const redelivery = yield* Queue.take(consumer.inbox)
        expect(redelivery.content).toEqual(body)
        expect(redelivery.fields.redelivered).toBe(true)
        yield* channel.ack(redelivery)
        yield* Fiber.interrupt(consumer.fiber)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")))
  }

  it.live("CA29 C-S94: prefetch one returns the first stream step without ack and admits the second only after ack", () =>
    Effect.gen(function*() {
      const { channel, queue } = yield* fixture()
      yield* channel.sendToQueue(queue, encode("first"))
      yield* channel.sendToQueue(queue, encode("second"))
      const consumer = yield* receive(channel, queue.queue, { prefetch: 1 })
      const first = yield* Queue.take(consumer.inbox)
      expect(decode(first.content)).toBe("first")
      // The ordered RPC reply fences delivery of everything the broker could admit before ack.
      expect((yield* channel.checkQueue(queue)).messageCount).toBe(1)
      expect(yield* Queue.size(consumer.inbox)).toBe(0)
      yield* channel.ack(first)
      const second = yield* Queue.take(consumer.inbox)
      expect(decode(second.content)).toBe("second")
      expect(second.fields.redelivered).toBe(false)
      yield* channel.ack(second)
      yield* Fiber.interrupt(consumer.fiber)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("CB12 CB13 C-T14: exclusive consumer on a non-exclusive durable queue delivers and cancels by explicit tag", () =>
    Effect.gen(function*() {
      const { channel, queue } = yield* fixture()
      const tag = `exclusive-${Crypto.randomUUID()}`
      const consumer = yield* receive(channel, queue.queue, { exclusive: true, consumerTag: tag })
      yield* channel.sendToQueue(queue, encode("exclusive consumer"))
      const message = yield* Queue.take(consumer.inbox)
      expect(message.fields.consumerTag).toBe(tag)
      expect(decode(message.content)).toBe("exclusive consumer")
      yield* channel.ack(message)
      yield* channel.cancel(tag)
      yield* Fiber.join(consumer.fiber)
      expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("C-S95: named manual consumer redelivers its actual unacked payload after connection reconnect", () =>
    Effect.gen(function*() {
      const { channel, connection, queue } = yield* fixture()
      const consumer = yield* receive(channel, queue.queue, { consumerTag: `manual-${Crypto.randomUUID()}` })
      const body = encode("unacked across connection replacement")
      yield* channel.sendToQueue(queue, body)
      const original = yield* Queue.take(consumer.inbox)
      expect(original.content).toEqual(body)
      expect(original.fields.redelivered).toBe(false)
      yield* connection.reconnect
      const redelivery = yield* Queue.take(consumer.inbox)
      expect(redelivery.content).toEqual(body)
      expect(redelivery.fields.redelivered).toBe(true)
      expect(redelivery.fields.consumerTag).toBe(original.fields.consumerTag)
      yield* channel.ack(redelivery)
      yield* Fiber.interrupt(consumer.fiber)
      expect((yield* channel.checkQueue(queue)).messageCount).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("C-S79: take one with prefetch one closes consumption leaving the untouched second for get", () =>
    Effect.gen(function*() {
      const { channel, queue } = yield* fixture()
      yield* channel.sendToQueue(queue, encode("first"))
      yield* channel.sendToQueue(queue, encode("untouched second"))
      const stream = yield* channel.consume(queue, { prefetch: 1 })
      const messages = yield* stream.pipe(Stream.take(1), Stream.runCollect)
      expect(messages.map((m) => decode(m.content))).toEqual(["first"])
      expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
      // Keep the first unacked until cancellation fences the second out of the consumer.
      for (const message of messages) yield* channel.ack(message)
      const second = yield* channel.get(queue)
      expect(Option.isSome(second)).toBe(true)
      if (Option.isSome(second)) {
        expect(decode(second.value.content)).toBe("untouched second")
        expect(second.value.fields.redelivered).toBe(false)
        yield* channel.ack(second.value)
      }
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("C-S09: repeated consume cancel cycles leave zero broker consumers without leaking channel capacity", () =>
    Effect.gen(function*() {
      const { channel, connection, queue } = yield* fixture()
      for (let i = 0; i < 20; i++) {
        const consumer = yield* receive(channel, queue.queue)
        yield* channel.sendToQueue(queue, encode(String(i)))
        const message = yield* Queue.take(consumer.inbox)
        expect(decode(message.content)).toBe(String(i))
        yield* channel.ack(message)
        yield* Fiber.interrupt(consumer.fiber)
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
        yield* Effect.scoped(connection.createChannel().pipe(Effect.andThen((probe) => probe.checkQueue(queue))))
      }
    }).pipe(Effect.scoped, Effect.timeout("15 seconds")))

  it.live("C-T78: consumer cleanup remains bounded after its parent channel closes", () =>
    Effect.gen(function*() {
      const { channel, cleanup, queue } = yield* fixture()
      const consumer = yield* receive(channel, queue.queue)
      yield* channel.sendToQueue(queue, encode("held"))
      yield* Queue.take(consumer.inbox)
      yield* channel.close
      yield* Fiber.interrupt(consumer.fiber)
      expect((yield* cleanup.checkQueue(queue)).consumerCount).toBe(0)
      const held = yield* cleanup.get(queue)
      expect(Option.isSome(held)).toBe(true)
      if (Option.isSome(held)) {
        expect(decode(held.value.content)).toBe("held")
        expect(held.value.fields.redelivered).toBe(true)
        yield* cleanup.ack(held.value)
      }
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  for (const failure of ["fail", "die"] as const) {
    it.live(`R-C02 R-C07 C-S50: adapter Effect.${failure} nacks without requeue, admits next handler, isolates other consumer`, () =>
      Effect.gen(function*() {
        const { channel, queue } = yield* fixture()
        const other = yield* channel.assertQueue("", { exclusive: true })
        const started = yield* Queue.unbounded<string>()
        const release = yield* Deferred.make<void>()
        const subscriber = yield* AMQPSubscriber.make(queue, { concurrency: 1 })
          .pipe(Effect.provideService(AMQPChannel.AMQPChannel, channel))
        const consumer = yield* receive(channel, other.queue)
        const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          const body = decode(message.content)
          yield* Queue.offer(started, body)
          if (body === "bad") {
            yield* Deferred.await(release)
            return yield* (failure === "fail" ? Effect.fail("ordinary handler failure") : Effect.die("handler defect"))
          }
          return AMQPSubscriberResponse.ack()
        })).pipe(Effect.forkScoped)
        yield* channel.sendToQueue(queue, encode("bad"))
        yield* channel.sendToQueue(queue, encode("next"))
        expect(yield* Queue.take(started)).toBe("bad")
        expect((yield* channel.checkQueue(queue)).messageCount).toBe(1)
        expect(yield* Queue.size(started)).toBe(0)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Queue.take(started)).toBe("next")
        yield* channel.sendToQueue(other, encode("unrelated still usable"))
        const unrelated = yield* Queue.take(consumer.inbox)
        expect(decode(unrelated.content)).toBe("unrelated still usable")
        yield* channel.ack(unrelated)
        yield* Fiber.interrupt(fiber)
        yield* Fiber.interrupt(consumer.fiber)
        expect((yield* channel.checkQueue(queue)).messageCount).toBe(0)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")))
  }
})
