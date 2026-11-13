import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import type * as AMQPChannel from "../src/AMQPChannel.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import type * as AMQPError from "../src/AMQPError.ts"
import { AMQPConnectionError } from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import { broker, encode } from "./dependencies.ts"

const setup = Effect.fnUntraced(function*() {
  const connection = yield* AMQPNodeConnection.make(broker)
  const publisher = yield* connection.createChannel({ confirm: true })
  const cleanup = yield* connection.createChannel()
  return { connection, publisher, cleanup }
})

const ownedQueue = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  cleanup: AMQPChannel.AMQPChannel,
  options: AMQPTypes.QueueOptions = {}
) {
  const name = `effect-extension-${randomUUID()}`
  yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
  return yield* channel.assertQueue(name, { durable: true, queueType: "classic", ...options })
})

const inbox = Effect.fnUntraced(function*(
  stream: Stream.Stream<AMQPConsumeMessage.AMQPConsumeMessage, AMQPError.AMQPError>
) {
  const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
  const fiber = yield* stream.pipe(
    Stream.runForEach((delivery) => Queue.offer(deliveries, delivery)),
    Effect.forkScoped
  )
  return { deliveries, fiber }
})

const BrokerVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+].*)?$/))

describe("AMQP native broker extension behavioral parity", () => {
  it.live(
    "maxLengthBytes counts body bytes, retaining exactly two eight-byte bodies at the boundary",
    () =>
      Effect.gen(function*() {
        const { publisher, cleanup } = yield* setup()
        const queue = yield* ownedQueue(publisher, cleanup, {
          maxLengthBytes: 16,
          arguments: { "x-max-length-bytes": 64 }
        })
        yield* publisher.sendToQueue(queue, encode("oldest00"))
        yield* publisher.sendToQueue(queue, encode("middle00"))
        expect((yield* publisher.checkQueue(queue)).messageCount).toBe(2)
        yield* publisher.sendToQueue(queue, encode("newest00"))
        // Each send awaits its independent publisher confirmation before this passive-declare barrier.
        expect((yield* publisher.checkQueue(queue)).messageCount).toBe(2)
        const retained: Array<Uint8Array> = []
        for (let index = 0; index < 2; index++) {
          const delivery = yield* publisher.get(queue)
          if (Option.isNone(delivery)) {
            return yield* new AMQPConnectionError({ reason: "Missing retained eight-byte body" })
          }
          retained.push(delivery.value.content)
          yield* publisher.ack(delivery.value)
        }
        expect(retained).toEqual([encode("middle00"), encode("newest00")])
        expect(yield* publisher.get(queue)).toEqual(Option.none())
        expect((yield* publisher.checkQueue(queue)).messageCount).toBe(0)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "singleActiveConsumer overrides raw false, promotes on cancel, and requeues held receipts on close",
    () =>
      Effect.gen(function*() {
        const { connection, publisher, cleanup } = yield* setup()
        const version = yield* Schema.decodeUnknownEffect(BrokerVersion)((yield* connection.serverProperties).version)
        const major = Number(version.split(".")[0])
        const queue = yield* ownedQueue(publisher, cleanup, {
          singleActiveConsumer: true,
          arguments: { "x-single-active-consumer": false }
        })
        const first = yield* connection.createChannel()
        const second = yield* connection.createChannel()
        const active = yield* inbox(yield* first.consume(queue, { prefetch: 1 }))
        yield* publisher.sendToQueue(queue, encode("red"))
        const red = yield* Queue.take(active.deliveries)
        expect(red.content).toEqual(encode("red"))
        expect(red.fields.redelivered).toBe(false)
        const standby = yield* inbox(yield* second.consume(queue, { prefetch: 1 }))
        yield* publisher.sendToQueue(queue, encode("blue"))
        yield* publisher.sendToQueue(queue, encode("green"))
        expect(yield* publisher.checkQueue(queue)).toMatchObject({ consumerCount: 2, messageCount: 2 })
        expect(yield* Queue.take(standby.deliveries).pipe(Effect.timeoutOption("1 second"))).toEqual(Option.none())
        expect(yield* Queue.size(active.deliveries)).toBe(0)
        // Interrupt waits for the stream's Basic.CancelOk finalizer, not merely a local fiber flag.
        yield* Fiber.interrupt(active.fiber)
        expect((yield* publisher.checkQueue(queue)).consumerCount).toBe(1)
        const drainPending = Effect.gen(function*() {
          for (const body of ["blue", "green"]) {
            const delivery = yield* Queue.take(standby.deliveries)
            expect(delivery.content).toEqual(encode(body))
            expect(delivery.fields.redelivered).toBe(false)
            yield* second.ack(delivery)
          }
        })
        // Pinned rabbit_amqqueue_process.erl: 4.x stop_consumer runs the queue immediately;
        // 3.13 basic_cancel only changes its holder and waits for another queue-running event.
        if (major >= 4) {
          yield* drainPending
          expect((yield* publisher.checkQueue(queue)).messageCount).toBe(0)
        }
        // Cancel preserves escaped red. Closing its originating channel requeues it in both versions.
        yield* first.close
        const requeued = yield* Queue.take(standby.deliveries)
        expect(requeued.content).toEqual(encode("red"))
        expect(requeued.fields.redelivered).toBe(true)
        yield* second.ack(requeued)
        if (major < 4) yield* drainPending
        yield* Fiber.interrupt(standby.fiber)
        expect(yield* publisher.checkQueue(queue)).toMatchObject({ consumerCount: 0, messageCount: 0 })
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "AMQP stream queue numeric and Date timestamp offsets select confirmed records",
    () =>
      Effect.gen(function*() {
        const { connection, publisher, cleanup } = yield* setup()
        const queue = yield* ownedQueue(publisher, cleanup, { queueType: "stream", maxLengthBytes: 20000000 })
        const timestamp = new Date(Math.floor(((yield* Clock.currentTimeMillis) - 60000) / 1000) * 1000)
        for (const body of ["zero", "one", "two"]) yield* publisher.sendToQueue(queue, encode(body))
        const numeric = yield* connection.createChannel()
        const fromOne = yield* numeric.consume(queue, { prefetch: 3, arguments: { "x-stream-offset": 1 } })
        const selected = yield* fromOne.pipe(
          Stream.mapEffect((delivery) => numeric.ack(delivery).pipe(Effect.as(delivery.content))),
          Stream.take(2),
          Stream.runCollect
        )
        expect(selected).toEqual([encode("one"), encode("two")])
        const dated = yield* connection.createChannel()
        const since = yield* dated.consume(queue, { prefetch: 3, arguments: { "x-stream-offset": timestamp } })
        const historical = yield* since.pipe(
          Stream.mapEffect((delivery) => dated.ack(delivery).pipe(Effect.as(delivery.content))),
          Stream.take(3),
          Stream.runCollect
        )
        expect(historical).toEqual([encode("zero"), encode("one"), encode("two")])
        expect((yield* publisher.checkQueue(queue)).consumerCount).toBe(0)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "global QoS gates noAck consumers through 4.2 and becomes per-consumer QoS on 4.3",
    () =>
      Effect.gen(function*() {
        const { connection, publisher, cleanup } = yield* setup()
        const version = yield* Schema.decodeUnknownEffect(BrokerVersion)((yield* connection.serverProperties).version)
        const [major, minor] = version.split(".").map(Number)
        const globalSupported = major < 4 || (major === 4 && minor <= 2)
        const manualQueue = yield* ownedQueue(publisher, cleanup)
        const automaticQueue = yield* ownedQueue(publisher, cleanup)
        const channel = yield* connection.createChannel()
        const manual = yield* inbox(yield* channel.consume(manualQueue, { prefetch: 1 }))
        const automatic = yield* inbox(yield* channel.consume(automaticQueue, { noAck: true, prefetch: 0 }))
        // Consumer registration applies per-consumer QoS; select the shared limit after both registrations.
        yield* channel.prefetch(1, true)
        yield* publisher.sendToQueue(manualQueue, encode("held"))
        const held = yield* Queue.take(manual.deliveries)
        expect(held.content).toEqual(encode("held"))
        yield* publisher.sendToQueue(automaticQueue, encode("automatic"))
        expect((yield* publisher.checkQueue(automaticQueue)).consumerCount).toBe(1)
        if (globalSupported) {
          // rabbitmq-java-client v5.27.0 QosTests.noAckObeysLimit uses the same bounded negative receive.
          expect(yield* Queue.take(automatic.deliveries).pipe(Effect.timeoutOption("1 second")))
            .toEqual(Option.none())
          expect((yield* publisher.checkQueue(automaticQueue)).messageCount).toBe(1)
          yield* channel.ack(held)
          expect((yield* Queue.take(automatic.deliveries)).content).toEqual(encode("automatic"))
        } else {
          // rabbitmq-server v4.3.6 rabbit_channel.erl rewrites denied global QoS to global=false, not 540.
          expect((yield* Queue.take(automatic.deliveries)).content).toEqual(encode("automatic"))
          yield* channel.ack(held)
        }
        yield* Fiber.interrupt(automatic.fiber)
        yield* Fiber.interrupt(manual.fiber)
        expect(yield* publisher.checkQueue(automaticQueue)).toMatchObject({ consumerCount: 0, messageCount: 0 })
        expect(yield* publisher.checkQueue(manualQueue)).toMatchObject({ consumerCount: 0, messageCount: 0 })
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )
})
