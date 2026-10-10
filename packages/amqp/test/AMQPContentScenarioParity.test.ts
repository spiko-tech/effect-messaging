import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Schedule, Stream } from "effect"
import { randomUUID } from "node:crypto"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { broker, encode, testConfirmChannel } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

// Independent frame envelope, not the client's encoder: AMQP 0-9-1 section 4.2.3.
const fixtureFrame = (type: number, channel: number, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(payload.byteLength + 8)
  const view = new DataView(frame.buffer)
  view.setUint8(0, type)
  view.setUint16(1, channel)
  view.setUint32(3, payload.byteLength)
  frame.set(payload, 7)
  frame[frame.length - 1] = 0xce
  return frame
}

const fixtureDelivery = (channel: number, tag: number, content: Uint8Array): Uint8Array => {
  const method = fixtureFrame(
    1,
    channel,
    new Uint8Array([
      0,
      60,
      0,
      60,
      18,
      115,
      121,
      110,
      116,
      104,
      101,
      116,
      105,
      99,
      45,
      99,
      111,
      110,
      115,
      117,
      109,
      101,
      114,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      tag,
      0,
      0,
      1,
      113
    ])
  )
  const header = fixtureFrame(
    2,
    channel,
    new Uint8Array([
      0,
      60,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      content.length,
      0,
      0
    ])
  )
  const body = content.length === 0 ? new Uint8Array() : fixtureFrame(3, channel, content)
  const bytes = new Uint8Array(method.length + header.length + body.length)
  bytes.set(method)
  bytes.set(header, method.length)
  bytes.set(body, method.length + header.length)
  return bytes
}

describe("AMQP public content scenario parity", () => {
  it.live("accepts a PLAIN secret update at RabbitMQ and publishes after the next handshake", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.connection.updateSecret("guest", "integration parity")
      yield* channel.connection.reconnect
      yield* channel.sendToQueue(queue, encode("after broker secret update"))
      const delivery = yield* channel.get(queue)
      expect(Option.isSome(delivery)).toBe(true)
      if (Option.isNone(delivery)) return
      expect(delivery.value.content).toEqual(encode("after broker secret update"))
      yield* channel.ack(delivery.value)
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("round-trips the complete property bag and heterogeneous array and table headers through RabbitMQ", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const properties = {
        contentType: "application/json",
        contentEncoding: "gzip",
        deliveryMode: 2,
        priority: 1,
        correlationId: "corr",
        replyTo: "me",
        expiration: "10000",
        messageId: "msgid",
        appId: "appid",
        userId: "guest",
        type: "type",
        timestamp: 1700000000n,
        headers: {
          integer: 2,
          boolean: true,
          string: "c",
          floating: AMQPTypes.fieldNumber("double", 1.5),
          nullable: null,
          date: new Date(1000),
          nested: { a: 1 },
          large: 4294967297n,
          largeFloating: AMQPTypes.fieldNumber("double", 2.5 ** 33),
          array: ["red", "blue", null, true, { a: 1 }],
          decimal: AMQPTypes.decimal(2, 1234)
        }
      }
      // The encoding property is metadata: the client must not gzip or interpret the bytes.
      yield* channel.sendToQueue(queue, encode("unchanged raw payload"), properties)
      const delivery = yield* channel.get(queue)
      expect(Option.isSome(delivery)).toBe(true)
      if (Option.isNone(delivery)) return
      expect(delivery.value.content).toEqual(encode("unchanged raw payload"))
      expect(delivery.value.properties).toEqual(properties)
      yield* channel.ack(delivery.value)
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testConfirmChannel)))
  it.live("consumes large valid binary, string and array headers with their complete bodies", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make({ ...broker, frameMax: 8192 })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const cases = [
        { body: encode("a".repeat(4000)), headers: { long: encode("a".repeat(4000)) } },
        { body: encode("b".repeat(8000)), headers: { long: "b".repeat(4000) } },
        { body: encode("c".repeat(8000)), headers: { long: Array.from({ length: 100 }, () => "c") } }
      ]
      for (let i = 0; i < cases.length; i++) {
        yield* channel.sendToQueue(queue, cases[i].body, { headers: cases[i].headers, messageId: String(i) })
      }
      const stream = yield* channel.consume(queue)
      const received = new Set<number>()
      yield* stream.pipe(
        Stream.take(3),
        Stream.runForEach((message) =>
          Effect.gen(function*() {
            const index = Number(message.properties.messageId)
            expect(index).toBeGreaterThanOrEqual(0)
            expect(index).toBeLessThan(3)
            expect(received.has(index)).toBe(false)
            received.add(index)
            expect(message.content).toEqual(cases[index].body)
            expect(message.properties.headers).toEqual(cases[index].headers)
            yield* channel.ack(message)
          })
        )
      )
      expect(received).toEqual(new Set([0, 1, 2]))
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped))

  it.live("preserves explicit transient delivery mode through default and declared exchanges", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const cleanup = yield* channel.connection.createChannel()
      const exchange = `effect-content-${randomUUID()}`
      yield* Effect.addFinalizer(() => cleanup.deleteExchange(exchange).pipe(Effect.ignore))
      yield* channel.assertExchange(exchange, "direct", { durable: false })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.bindQueue(queue, exchange, "key")
      yield* channel.sendToQueue(queue, encode("default transient"), { deliveryMode: 1 })
      yield* channel.publish(exchange, "key", encode("exchange transient"), { deliveryMode: 1 })
      for (const body of ["default transient", "exchange transient"]) {
        const delivery = yield* channel.get(queue)
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isNone(delivery)) continue
        expect(delivery.value.content).toEqual(encode(body))
        expect(delivery.value.properties.deliveryMode).toBe(1)
        yield* channel.ack(delivery.value)
      }
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel)))

  it.live("round-trips a 15000-byte header under the negotiated 16384-byte frame maximum", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make({ ...broker, frameMax: 16384 })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const long = "a".repeat(15000)
      yield* channel.sendToQueue(queue, new Uint8Array(), { headers: { long } })
      const delivery = yield* channel.get(queue)
      expect(Option.isSome(delivery)).toBe(true)
      if (Option.isNone(delivery)) return
      expect(delivery.value.content).toEqual(new Uint8Array())
      expect(delivery.value.properties.headers).toEqual({ long })
      yield* channel.ack(delivery.value)
    }).pipe(Effect.scoped))

  it.live("preserves bodies at reference sizes and across the negotiated body-frame boundary", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make({ ...broker, frameMax: 8192 })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      for (const size of [4087, 4088, 4089, 4096, 5000, 10000, 8183, 8184, 8185, 16368, 16369]) {
        const content = Uint8Array.from({ length: size }, (_, index) => index % 251)
        yield* channel.sendToQueue(queue, content)
        const delivery = yield* channel.get(queue)
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isNone(delivery)) continue
        expect(delivery.value.content).toEqual(content)
        yield* channel.ack(delivery.value)
      }
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped))

  for (const shape of ["long string", "collection"] as const) {
    it.effect(`rejects an oversized outbound ${shape} header without sending frames or leaking confirm capacity`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker({ frameMax: 8192 })
        const connection = yield* AMQPConnection.make(broker.factory, { frameMax: 8192 })
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 1 })
        yield* Queue.clear(session.frames)
        const headers = shape === "long string"
          ? { long: "a".repeat(9000) }
          : { long: Array.from({ length: 3000 }, () => "a") }
        expectFailure(yield* channel.publish("", "q", encode("invalid"), { headers }).pipe(Effect.exit), {
          _tag: "AMQPPublishError",
          outcome: "NotSent"
        })
        expect(yield* Queue.clear(session.frames)).toEqual([])
        const publishing = yield* channel.publish("", "q", encode("valid")).pipe(Effect.forkChild)
        yield* Queue.take(session.publishes)
        yield* session.reply(1, 60, 80, { deliveryTag: 1n, multiple: false })
        yield* Fiber.join(publishing)
        yield* channel.prefetch(1)
      }).pipe(Effect.scoped))
  }

  for (
    const fixture of [
      { name: "null", content: null },
      { name: "ArrayBuffer", content: new ArrayBuffer(3) },
      { name: "string", content: "not bytes" }
    ]
  ) {
    it.effect(`rejects runtime-invalid ${fixture.name} content as NotSent without poisoning subsequent confirms`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory)
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 1 })
        yield* Queue.clear(session.frames)
        // @ts-expect-error Deliberately exercise invalid input from untyped JavaScript callers.
        const invalid = yield* channel.publish("", "q", fixture.content).pipe(Effect.exit)
        expectFailure(invalid, { _tag: "AMQPPublishError", outcome: "NotSent" })
        expect(yield* Queue.clear(session.frames)).toEqual([])
        const valid = yield* channel.publish("", "q", encode("valid")).pipe(Effect.forkChild)
        yield* Queue.take(session.publishes)
        yield* session.reply(1, 60, 80, { deliveryTag: 1n, multiple: false })
        yield* Fiber.join(valid)
      }).pipe(Effect.scoped))
  }

  it.effect("rejects a runtime-invalid contentEncoding before admission and confirms a subsequent valid publication", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 1 })
      yield* Queue.clear(session.frames)
      // @ts-expect-error Deliberately exercise invalid input from untyped JavaScript callers.
      const invalid = yield* channel.publish("", "q", encode("invalid"), { contentEncoding: 7 }).pipe(Effect.exit)
      expectFailure(invalid, { _tag: "AMQPPublishError", outcome: "NotSent" })
      expect(yield* Queue.clear(session.frames)).toEqual([])
      const valid = yield* channel.publish("", "q", encode("valid")).pipe(Effect.forkChild)
      yield* Queue.take(session.publishes)
      yield* session.reply(1, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* Fiber.join(valid)
    }).pipe(Effect.scoped))

  it.effect("sends no body frame for empty publishes and keeps following method, header and body frames ordered", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, { frameMax: 4096 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      yield* Queue.clear(session.frames)
      yield* channel.publish("", "q", new Uint8Array())
      yield* channel.publish("", "q", new Uint8Array())
      yield* channel.publish("", "q", encode("next"))
      const frames = yield* Queue.clear(session.frames)
      expect(frames.map((frame) => frame.type)).toEqual([1, 2, 1, 2, 1, 2, 3])
      expect(frames[1].payload).toEqual(new Uint8Array([0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
      expect(frames[3].payload).toEqual(frames[1].payload)
      expect(frames[5].payload).toEqual(new Uint8Array([0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0]))
      expect(frames[6].payload).toEqual(encode("next"))
    }).pipe(Effect.scoped))

  it.effect("transmits a valid 3000-byte content header alongside a nonempty body", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, { frameMax: 4096 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      yield* Queue.clear(session.frames)
      const long = new Uint8Array(3000).fill(97)
      yield* channel.publish("", "q", encode("nonempty"), { headers: { long } })
      const frames = yield* Queue.clear(session.frames)
      expect(frames.map((frame) => frame.type)).toEqual([1, 2, 3])
      const header = yield* Codec.decodeContentHeader(frames[1].payload)
      expect(header.bodySize).toBe(8n)
      expect(header.properties.headers).toEqual({ long })
      expect(frames[2].payload).toEqual(encode("nonempty"))
    }).pipe(Effect.scoped))

  it.effect("assembles deliveries from independently encoded frames split and coalesced across socket reads", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(0) })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const stream = yield* channel.consume("q")
      const consuming = yield* stream.pipe(
        Stream.take(3),
        Stream.mapEffect((message) => channel.ack(message).pipe(Effect.as(message.content))),
        Stream.runCollect,
        Effect.forkChild
      )
      const consumer = yield* nextMethod(session, 60, 20)
      const first = fixtureDelivery(consumer.channel, 1, encode("alpha"))
      const second = fixtureDelivery(consumer.channel, 2, new Uint8Array())
      const third = fixtureDelivery(consumer.channel, 3, encode("omega"))
      // Split the envelope, consumer name, uint64 body size, body and both frame terminators.
      const boundaries = [0, 1, 4, 7, 23, 42, 43, 55, 64, 65, 74]
      for (let i = 1; i < boundaries.length; i++) {
        yield* session.send(first.subarray(boundaries[i - 1], boundaries[i]))
      }
      const remaining = new Uint8Array(first.length - 74 + second.length + third.length)
      remaining.set(first.subarray(74))
      remaining.set(second, first.length - 74)
      remaining.set(third, first.length - 74 + second.length)
      // One read holds a body tail and two further complete deliveries.
      yield* session.send(remaining)
      expect(yield* Fiber.join(consuming)).toEqual([encode("alpha"), new Uint8Array(), encode("omega")])
      yield* channel.prefetch(1)
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))
})
