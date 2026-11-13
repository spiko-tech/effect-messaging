import { describe, expect, it } from "@effect/vitest"
import * as Reference from "amqplib"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import type * as AMQPChannel from "../src/AMQPChannel.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import { AMQPConnectionError } from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTopology from "../src/AMQPTopology.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import { broker, encode } from "./dependencies.ts"

const unique = () => `effect-options-${randomUUID()}`
const foreign = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => new AMQPConnectionError({ reason: "Pinned reference client operation failed", cause })
  })
const reference = Effect.acquireRelease(
  foreign(() => Reference.connect(broker)),
  (connection) => foreign(() => connection.close()).pipe(Effect.ignore)
)
const referenceChannel = Effect.fnUntraced(function*(connection: Reference.ChannelModel) {
  return yield* Effect.acquireRelease(
    foreign(() => connection.createChannel()),
    (channel) => foreign(() => channel.close()).pipe(Effect.ignore)
  )
})
const setup = Effect.fnUntraced(function*() {
  const connection = yield* AMQPNodeConnection.make(broker)
  const channel = yield* connection.createChannel({ confirm: true })
  const cleanup = yield* connection.createChannel()
  return { connection, channel, cleanup }
})
const namedQueue = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  cleanup: AMQPChannel.AMQPChannel,
  options: AMQPTypes.QueueOptions = {}
) {
  const name = unique()
  yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
  return yield* channel.assertQueue(name, { durable: true, ...options })
})
const namedExchange = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  cleanup: AMQPChannel.AMQPChannel,
  type: string,
  options: AMQPTypes.ExchangeOptions = {}
) {
  const name = unique()
  yield* Effect.addFinalizer(() => cleanup.deleteExchange(name).pipe(Effect.ignore))
  yield* channel.assertExchange(name, type, { durable: true, ...options })
  return name
})
const next = Effect.fnUntraced(function*(channel: AMQPChannel.AMQPChannel, queue: AMQPTopology.QueueName) {
  const delivery = yield* channel.get(queue).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: Option.isSome
    }),
    Effect.timeout("5 seconds")
  )
  if (Option.isNone(delivery)) return yield* new AMQPConnectionError({ reason: "Missing expected broker delivery" })
  return delivery.value
})

describe("AMQP option aliases and independent-client interoperability", () => {
  it.live("retains inherited arguments and options without rereading changing getters", () =>
    Effect.gen(function*() {
      const { channel, cleanup } = yield* setup()
      const deadLetter = yield* namedExchange(channel, cleanup, "fanout")
      const dead = yield* namedQueue(channel, cleanup)
      yield* channel.bindQueue(dead, deadLetter, "")
      let reads = 0
      const inherited = Object.create({ "x-message-ttl": 100, "x-dead-letter-exchange": deadLetter })
      Object.defineProperty(inherited, "custom", {
        enumerable: true,
        get: () => ++reads === 1 ? 1 : NaN
      })
      const options = Object.create({ durable: true, arguments: inherited })
      const name = unique()
      yield* Effect.addFinalizer(() => cleanup.deleteQueue(name).pipe(Effect.ignore))
      const source = yield* channel.assertQueue(name, options)
      expect(reads).toBe(1)
      yield* channel.sendToQueue(source, encode("inherited ttl"))
      const delivery = yield* next(channel, dead)
      expect(delivery.content).toEqual(encode("inherited ttl"))
      yield* channel.ack(delivery)
      expect(yield* channel.get(source)).toEqual(Option.none())
    }).pipe(Effect.scoped), 15000)

  it.live(
    "routes CC and BCC aliases, overriding raw headers and hiding BCC from recipients",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const exchange = yield* namedExchange(channel, cleanup, "direct")
        const queues = yield* Effect.forEach(["main", "copy", "blind", "wrong"], (key) =>
          Effect.gen(function*() {
            const queue = yield* namedQueue(channel, cleanup)
            yield* channel.bindQueue(queue, exchange, key)
            return queue
          }))
        const options = { CC: ["copy"], BCC: "blind", headers: { CC: ["wrong"], BCC: ["wrong"], retained: true } }
        yield* channel.publish(exchange, "main", encode("copies"), options)
        for (const queue of queues.slice(0, 3)) {
          const delivery = yield* next(channel, queue)
          expect(delivery.content).toEqual(encode("copies"))
          expect(delivery.properties.headers).toMatchObject({ CC: ["copy"], retained: true })
          expect(delivery.properties.headers?.BCC).toBeUndefined()
          yield* channel.ack(delivery)
        }
        expect(yield* channel.get(queues[3])).toEqual(Option.none())
      }).pipe(Effect.scoped),
    15000
  )

  it.live(
    "uses the alternateExchange alias ahead of raw arguments for otherwise unroutable publications",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const alternate = yield* namedExchange(channel, cleanup, "fanout")
        const options = { alternateExchange: alternate, arguments: { "alternate-exchange": unique() } }
        const source = yield* namedExchange(channel, cleanup, "direct", options)
        const queue = yield* namedQueue(channel, cleanup)
        yield* channel.bindQueue(queue, alternate, "")
        yield* channel.publish(source, "unbound", encode("alternate"))
        const delivery = yield* next(channel, queue)
        expect(delivery.content).toEqual(encode("alternate"))
        yield* channel.ack(delivery)
      }).pipe(Effect.scoped),
    15000
  )

  it.live(
    "applies messageTtl and dead-letter aliases with convenience values taking precedence",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const deadLetter = yield* namedExchange(channel, cleanup, "direct")
        const dead = yield* namedQueue(channel, cleanup)
        yield* channel.bindQueue(dead, deadLetter, "expired")
        const options = {
          messageTtl: 100,
          deadLetterExchange: deadLetter,
          deadLetterRoutingKey: "expired",
          arguments: {
            "x-message-ttl": 60000,
            "x-dead-letter-exchange": unique(),
            "x-dead-letter-routing-key": "wrong"
          }
        }
        const source = yield* namedQueue(channel, cleanup, options)
        yield* channel.sendToQueue(source, encode("expires"))
        const delivery = yield* next(channel, dead)
        expect(delivery.content).toEqual(encode("expires"))
        expect(delivery.properties.headers?.["x-death"]).toEqual(expect.arrayContaining([
          expect.objectContaining({ reason: "expired", queue: source.queue })
        ]))
        yield* channel.ack(delivery)
        expect(yield* channel.get(source)).toEqual(Option.none())
      }).pipe(Effect.scoped),
    15000
  )

  it.live(
    "bounds queue length and enables classic message priority through convenience options",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const boundedOptions = { maxLength: 2, arguments: { "x-max-length": 5 } }
        const bounded = yield* namedQueue(channel, cleanup, boundedOptions)
        for (const body of ["discarded", "retained-first", "retained-second"]) {
          yield* channel.sendToQueue(bounded, encode(body))
        }
        expect((yield* channel.checkQueue(bounded)).messageCount).toBe(2)
        for (const body of ["retained-first", "retained-second"]) {
          const delivery = yield* next(channel, bounded)
          expect(delivery.content).toEqual(encode(body))
          yield* channel.ack(delivery)
        }
        expect(yield* channel.get(bounded)).toEqual(Option.none())
        // Drop-head on a full priority queue can evict a newly arriving high-priority message.
        // Verify priority independently, with both publications queued before registering a consumer.
        const priorityOptions = { maxPriority: 10, arguments: { "x-max-priority": 1 } }
        const queue = yield* namedQueue(channel, cleanup, priorityOptions)
        yield* channel.sendToQueue(queue, encode("low"), { priority: 1 })
        yield* channel.sendToQueue(queue, encode("high"), { priority: 9 })
        // PriorityQueues.prioritisingBasics uses delivery ordering, not basic.get polling.
        const stream = yield* channel.consume(queue, { prefetch: 2 })
        const deliveries = yield* stream.pipe(Stream.take(2), Stream.runCollect)
        expect(deliveries.map((delivery) => delivery.content)).toEqual([encode("high"), encode("low")])
        for (const delivery of deliveries) yield* channel.ack(delivery)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped),
    15000
  )

  it.live("matches pinned amqplib queue expiration and overflow argument declarations", () =>
    Effect.gen(function*() {
      const { channel, cleanup } = yield* setup()
      const peer = yield* referenceChannel(yield* reference)
      const options = { expires: 30000, maxLength: 1, overflow: "reject-publish" }
      const queue = yield* namedQueue(channel, cleanup, options)
      const declared = yield* foreign(() =>
        peer.assertQueue(queue.queue, {
          durable: true,
          arguments: { "x-expires": 30000, "x-max-length": 1, "x-overflow": "reject-publish" }
        })
      )
      expect(declared.queue).toBe(queue.queue)
      yield* channel.sendToQueue(queue, encode("accepted"))
      const result = yield* Effect.result(channel.sendToQueue(queue, encode("rejected")))
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AMQPPublishError", outcome: "Nacked" } })
      const delivered = yield* next(channel, queue)
      expect(delivered.content).toEqual(encode("accepted"))
      yield* channel.ack(delivered)
    }).pipe(Effect.scoped), 15000)

  it.live(
    "delivers to higher-priority consumers first and falls back when their finite prefetch is full",
    () =>
      Effect.gen(function*() {
        const { connection, channel, cleanup } = yield* setup()
        const queue = yield* namedQueue(channel, cleanup)
        const lower = yield* connection.createChannel()
        const higher = yield* connection.createChannel()
        const lowInbox = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const highInbox = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const low = yield* lower.consume(queue, { prefetch: 1, priority: 1 })
        const high = yield* higher.consume(queue, { prefetch: 1, priority: 10, arguments: { "x-priority": -1 } })
        const lowFiber = yield* low.pipe(
          Stream.runForEach((delivery) => Queue.offer(lowInbox, delivery)),
          Effect.forkChild
        )
        const highFiber = yield* high.pipe(
          Stream.runForEach((delivery) => Queue.offer(highInbox, delivery)),
          Effect.forkChild
        )
        yield* channel.sendToQueue(queue, encode("preferred"))
        const first = yield* Queue.take(highInbox)
        expect(first.content).toEqual(encode("preferred"))
        yield* channel.sendToQueue(queue, encode("fallback"))
        const second = yield* Queue.take(lowInbox)
        expect(second.content).toEqual(encode("fallback"))
        yield* higher.ack(first)
        yield* lower.ack(second)
        yield* Fiber.interrupt(highFiber)
        yield* Fiber.interrupt(lowFiber)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "consumes AMQP stream queues with raw extension arguments and explicit offsets",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const queue = yield* namedQueue(channel, cleanup, {
          arguments: { "x-queue-type": "stream", "x-max-length-bytes": 20000000 }
        })
        yield* channel.sendToQueue(queue, encode("stream record"))
        const stream = yield* channel.consume(queue, { prefetch: 1, arguments: { "x-stream-offset": "first" } })
        const deliveries = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        expect(deliveries[0].content).toEqual(encode("stream record"))
        yield* channel.ack(deliveries[0])
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "native publish is independently decoded by pinned amqplib with properties and field values intact",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const queue = yield* namedQueue(channel, cleanup)
        const peer = yield* referenceChannel(yield* reference)
        const properties = {
          contentType: "application/octet-stream",
          contentEncoding: "identity",
          persistent: true,
          priority: 3,
          correlationId: "correlation",
          replyTo: "reply.queue",
          expiration: 30000,
          messageId: "native-to-reference",
          timestamp: 1700000000n,
          type: "event",
          userId: "guest",
          appId: "native",
          headers: {
            flag: true,
            integer: -32769,
            long: 4294967297n,
            float: AMQPTypes.fieldNumber("float", 1.5),
            double: AMQPTypes.fieldNumber("double", 2.5),
            decimal: AMQPTypes.decimal(2, 1234),
            timestamp: new Date(1700000000000),
            binary: new Uint8Array([0, 255, 128]),
            nested: { values: [null, "text", false] }
          }
        }
        yield* channel.sendToQueue(queue, new Uint8Array([0, 255, 128, 42]), properties)
        const received = yield* foreign(() => peer.get(queue.queue))
        expect(received).not.toBe(false)
        if (received === false) return
        expect(received.content).toEqual(Buffer.from([0, 255, 128, 42]))
        expect(received.properties).toMatchObject({
          contentType: properties.contentType,
          contentEncoding: properties.contentEncoding,
          deliveryMode: 2,
          priority: 3,
          correlationId: properties.correlationId,
          replyTo: properties.replyTo,
          expiration: "30000",
          messageId: properties.messageId,
          timestamp: 1700000000,
          type: properties.type,
          userId: "guest",
          appId: "native",
          headers: {
            flag: true,
            integer: -32769,
            long: 4294967297,
            float: 1.5,
            double: 2.5,
            decimal: { "!": "decimal", value: { places: 2, digits: 1234 } },
            timestamp: { "!": "timestamp", value: 1700000000 },
            binary: Buffer.from([0, 255, 128]),
            nested: { values: [null, "text", false] }
          }
        })
        yield* Effect.try({
          try: () => peer.ack(received),
          catch: (cause) => new AMQPConnectionError({ reason: "Pinned reference settlement failed", cause })
        })
      }).pipe(Effect.scoped),
    15000
  )

  it.live(
    "pinned amqplib publish is decoded natively, including unsigned widths, decimal and timestamp fields",
    () =>
      Effect.gen(function*() {
        const { channel, cleanup } = yield* setup()
        const queue = yield* namedQueue(channel, cleanup)
        const peer = yield* referenceChannel(yield* reference)
        yield* Effect.try({
          try: () =>
            peer.sendToQueue(queue.queue, Buffer.from([0, 255, 128, 42]), {
              contentType: "application/octet-stream",
              persistent: true,
              correlationId: "correlation",
              messageId: "reference-to-native",
              timestamp: 1700000000,
              headers: {
                tiny: { "!": "int8", value: 1 },
                byte: { "!": "uint8", value: 255 },
                narrow: { "!": "int16", value: 1 },
                short: { "!": "uint16", value: 65535 },
                wide: { "!": "int32", value: 1 },
                integer: { "!": "uint32", value: 4294967295 },
                signed: { "!": "int64", value: -4294967297 },
                float: { "!": "float", value: 1.5 },
                double: { "!": "double", value: 2.5 },
                decimal: { "!": "decimal", value: { places: 2, digits: 1234 } },
                timestamp: { "!": "timestamp", value: 1700000000 },
                binary: Buffer.from([0, 255, 128]),
                nested: { values: [null, "text", false] }
              }
            }),
          catch: (cause) => new AMQPConnectionError({ reason: "Pinned reference publication failed", cause })
        })
        const delivery = yield* next(channel, queue)
        expect(delivery.content).toEqual(new Uint8Array([0, 255, 128, 42]))
        expect(delivery.properties).toMatchObject({
          contentType: "application/octet-stream",
          deliveryMode: 2,
          correlationId: "correlation",
          messageId: "reference-to-native",
          timestamp: 1700000000n,
          headers: {
            tiny: 1,
            byte: AMQPTypes.fieldInteger("uint8", 255),
            narrow: AMQPTypes.fieldInteger("int16", 1),
            short: AMQPTypes.fieldInteger("uint16", 65535),
            wide: AMQPTypes.fieldInteger("int32", 1),
            integer: AMQPTypes.fieldInteger("uint32", 4294967295),
            signed: -4294967297n,
            float: AMQPTypes.fieldNumber("float", 1.5),
            double: AMQPTypes.fieldNumber("double", 2.5),
            decimal: AMQPTypes.decimal(2, 1234),
            timestamp: new Date(1700000000000),
            binary: new Uint8Array([0, 255, 128]),
            nested: { values: [null, "text", false] }
          }
        })
        yield* channel.sendToQueue(queue, delivery.content, { headers: delivery.properties.headers ?? {} })
        const repeated = yield* next(channel, queue)
        expect(repeated.properties.headers).toEqual(delivery.properties.headers)
        yield* channel.ack(repeated)
        yield* channel.ack(delivery)
      }).pipe(Effect.scoped),
    15000
  )
})
