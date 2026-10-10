import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Schedule, Stream } from "effect"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

// Independent AMQP 0-9-1 fixture: class, weight, empty body, headers flag, table length, table.
const header = (table: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(18 + table.length)
  bytes.set([0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0])
  new DataView(bytes.buffer).setUint32(14, table.length)
  bytes.set(table, 18)
  return bytes
}

const republish = Effect.fnUntraced(function*(payload: Uint8Array, properties?: AMQPTypes.MessageProperties) {
  const broker = yield* makeBroker()
  const connection = yield* AMQPConnection.make(broker.factory)
  const session = yield* Queue.take(broker.sessions)
  const channel = yield* connection.createChannel()
  const messages = yield* channel.consume("queue")
  const consuming = yield* messages.pipe(
    Stream.take(1),
    Stream.runForEach((message) => channel.publish("", "copy", message.content, properties ?? message.properties)),
    Effect.forkChild
  )
  const consumer = yield* nextMethod(session, 60, 20)
  yield* session.reply(consumer.channel, 60, 60, {
    consumerTag: "synthetic-consumer",
    deliveryTag: 1n,
    exchange: "",
    routingKey: "queue"
  })
  yield* session.send(yield* Codec.encodeFrame(2, consumer.channel, payload))
  while (true) {
    const frame = yield* Queue.take(session.frames)
    if (frame.type === 2) {
      yield* Fiber.join(consuming)
      return frame.payload
    }
  }
})

describe("AMQP wire compatibility through consume and publish", () => {
  it.effect("preserves the long-string wire tag when consuming and republishing opaque non-UTF-8 headers", () =>
    Effect.gen(function*() {
      const fixture = header([1, 110, 83, 0, 0, 0, 1, 255])
      expect(yield* republish(fixture)).toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("allows explicit long-string bytes without changing ordinary text or byte-array header types", () =>
    Effect.gen(function*() {
      const fixture = header([
        1,
        110,
        83,
        0,
        0,
        0,
        1,
        255,
        1,
        116,
        83,
        0,
        0,
        0,
        1,
        97,
        1,
        120,
        120,
        0,
        0,
        0,
        1,
        255
      ])
      expect(
        yield* republish(header([]), {
          headers: { n: AMQPTypes.longString(new Uint8Array([255])), t: "a", x: new Uint8Array([255]) }
        })
      ).toEqual(fixture)
      expect(yield* republish(fixture)).toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("preserves integral float and double header types used by headers-exchange routing", () =>
    Effect.gen(function*() {
      const fixture = header([1, 102, 102, 63, 128, 0, 0, 1, 100, 100, 63, 240, 0, 0, 0, 0, 0, 0])
      expect(yield* republish(fixture)).toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("does not reinterpret a decoded nested table named Decimal as a decimal scalar", () =>
    Effect.gen(function*() {
      const fixture = header([
        1,
        110,
        70,
        0,
        0,
        0,
        33,
        4,
        95,
        116,
        97,
        103,
        83,
        0,
        0,
        0,
        7,
        68,
        101,
        99,
        105,
        109,
        97,
        108,
        5,
        115,
        99,
        97,
        108,
        101,
        98,
        1,
        5,
        118,
        97,
        108,
        117,
        101,
        98,
        2
      ])
      expect(yield* republish(fixture)).toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("treats an ordinary application table named Decimal as a table, not a scalar request", () =>
    Effect.gen(function*() {
      const fixture = header([
        1,
        110,
        70,
        0,
        0,
        0,
        33,
        4,
        95,
        116,
        97,
        103,
        83,
        0,
        0,
        0,
        7,
        68,
        101,
        99,
        105,
        109,
        97,
        108,
        5,
        115,
        99,
        97,
        108,
        101,
        98,
        1,
        5,
        118,
        97,
        108,
        117,
        101,
        98,
        2
      ])
      expect(yield* republish(fixture, { headers: { n: { _tag: "Decimal", scale: 1, value: 2 } } }))
        .toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("rejects a small wire header whose decoded collection nodes exceed the memory limit", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        maxBufferedBytes: 1024 * 1024,
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const messages = yield* channel.consume("queue")
      yield* messages.pipe(Stream.runDrain, Effect.forkChild)
      const consumer = yield* nextMethod(session, 60, 20)
      // A single array containing 20,000 independently encoded empty tables: ~100KiB on wire.
      const table = [1, 110, 65, 0, 1, 134, 160]
      for (let i = 0; i < 20000; i++) table.push(70, 0, 0, 0, 0)
      yield* session.reply(consumer.channel, 60, 60, {
        consumerTag: "synthetic-consumer",
        deliveryTag: 1n,
        exchange: "",
        routingKey: "queue"
      })
      yield* session.send(yield* Codec.encodeFrame(2, consumer.channel, header(table)))
      expectFailure(yield* Effect.exit(channel.prefetch(1)), { _tag: "AMQPConnectionError", permanent: true })
    }).pipe(Effect.scoped))

  it.effect("supports explicit float, double and decimal requests without reserving table keys", () =>
    Effect.gen(function*() {
      const fixture = header([
        1,
        102,
        102,
        63,
        128,
        0,
        0,
        1,
        100,
        100,
        63,
        240,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        110,
        68,
        1,
        0,
        0,
        0,
        2
      ])
      expect(
        yield* republish(header([]), {
          headers: {
            f: AMQPTypes.fieldNumber("float", 1),
            d: AMQPTypes.fieldNumber("double", 1),
            n: AMQPTypes.decimal(1, 2)
          }
        })
      ).toEqual(fixture)
      expect(yield* republish(fixture)).toEqual(fixture)
    }).pipe(Effect.scoped))

  it.effect("preserves typed scalar arguments and snapshots their values across topology recovery", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(2) })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const floating = { ...AMQPTypes.fieldNumber("double", 1) }
      const decimal = { ...AMQPTypes.decimal(2, 123) }
      const opaque = AMQPTypes.longString(new Uint8Array([255]))
      yield* channel.assertQueue("numeric-arguments", { arguments: { floating, decimal, opaque } })
      const expected = {
        floating: AMQPTypes.fieldNumber("double", 1),
        decimal: AMQPTypes.decimal(2, 123),
        opaque: AMQPTypes.longString(new Uint8Array([255]))
      }
      expect((yield* nextMethod(session, 50, 10)).fields.arguments).toEqual(expected)
      floating.value = 99
      decimal.value = 999
      opaque.bytes[0] = 0
      yield* connection.reconnect
      const replacement = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(replacement, 50, 10)).fields.arguments).toEqual(expected)
    }).pipe(Effect.scoped))
})
