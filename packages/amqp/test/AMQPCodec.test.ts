import { describe, expect, it, vi } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { AMQPProtocolError } from "../src/AMQPError.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"
import type * as Codec from "../src/internal/codec.ts"
import {
  ContentHeaderCodec,
  decodeContentHeader,
  decodeMethod,
  encodeContentHeader,
  encodeFieldTable,
  encodeFrame,
  encodeMethod,
  FieldTableCodec,
  FrameCodec,
  makeContentHeaderCodec,
  makeFrameDecoder,
  MAX_DECODED_BYTES,
  MethodCodec,
  PROTOCOL_HEADER
} from "../src/internal/codec.ts"

const bytes = (...values: Array<number>): Uint8Array => new Uint8Array(values)
const payload = (frame: Uint8Array): Uint8Array => frame.subarray(7, frame.length - 1)
const concat = (...chunks: Array<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
const malformed = Effect.fnUntraced(function*<A>(effect: Effect.Effect<A, AMQPProtocolError>) {
  const result = yield* Effect.result(effect)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(AMQPProtocolError)
})
const schemaFailure = Effect.fnUntraced(function*<A>(effect: Effect.Effect<A, AMQPProtocolError>) {
  const result = yield* Effect.result(effect)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(AMQPProtocolError)
    expect(Schema.isSchemaError(result.failure.cause)).toBe(true)
  }
})
const tablePayload = (entries: Uint8Array): Uint8Array => {
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, entries.length)
  // Basic content class, weight, body size, headers property flag, field table.
  return concat(bytes(0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0), length, entries)
}
const tableEntry = (tag: string, value: Uint8Array, key = "a"): Uint8Array =>
  concat(bytes(key.length), new TextEncoder().encode(key), bytes(tag.charCodeAt(0)), value)

describe("AMQP 0-9-1 wire codec", () => {
  it.effect("allocates fresh wire readers and writers on every execution of a codec Effect", () =>
    Effect.gen(function*() {
      const fields = { deliveryTag: 0xffffffffffffffffn, multiple: true }
      const methodEffect = encodeMethod(1, 60, 80, fields)
      const firstMethod = yield* methodEffect
      const secondMethod = yield* methodEffect
      expect(secondMethod).toEqual(firstMethod)
      expect(secondMethod).not.toBe(firstMethod)
      const decodedMethod = decodeMethod(payload(firstMethod))
      expect(yield* decodedMethod).toEqual(yield* decodedMethod)

      const headerEffect = encodeContentHeader(1, 0n, { headers: { nested: [true, "text"] } })
      const firstHeader = yield* headerEffect
      const secondHeader = yield* headerEffect
      expect(secondHeader).toEqual(firstHeader)
      expect(secondHeader).not.toBe(firstHeader)
      const decodeHeaderEffect = decodeContentHeader(payload(firstHeader))
      expect(yield* decodeHeaderEffect).toEqual(yield* decodeHeaderEffect)

      const tableEffect = encodeFieldTable({ binary: bytes(0, 255) })
      const firstTable = yield* tableEffect
      const secondTable = yield* tableEffect
      expect(secondTable).toEqual(firstTable)
      expect(secondTable).not.toBe(firstTable)
      const frameEffect = encodeFrame(3, 1, bytes(0, 255))
      const firstFrame = yield* frameEffect
      const secondFrame = yield* frameEffect
      expect(secondFrame).toEqual(firstFrame)
      expect(secondFrame).not.toBe(firstFrame)
    }))

  it.effect("exposes real binary Schema codecs for frames, methods, content headers and field tables", () =>
    Effect.gen(function*() {
      const body = bytes(0, 255, 192, 175, 0)
      const frame = { type: 3, channel: 1, payload: body }
      const encodedFrame = yield* Schema.encodeEffect(FrameCodec)(frame)
      expect(encodedFrame).toEqual(yield* encodeFrame(3, 1, body))
      expect(yield* Schema.decodeEffect(FrameCodec)(encodedFrame)).toEqual(frame)

      const method = { classId: 60, methodId: 80, fields: { deliveryTag: 0xffffffffffffffffn, multiple: false } }
      const encodedMethod = yield* Schema.encodeEffect(MethodCodec)(method)
      expect(encodedMethod).toEqual(payload(yield* encodeMethod(1, 60, 80, method.fields)))
      expect(yield* Schema.decodeEffect(MethodCodec)(encodedMethod)).toEqual(method)

      const table = { nested: [true, null, { bytes: body }], decimal: AMQPTypes.decimal(2, 5) }
      const encodedTable = yield* Schema.encodeEffect(FieldTableCodec)(table)
      expect(encodedTable).toEqual(yield* encodeFieldTable(table))
      expect(yield* Schema.decodeEffect(FieldTableCodec)(encodedTable)).toEqual(table)

      const header = { bodySize: 5n, properties: { headers: table, priority: 255 }, decodedCost: 0 }
      const encodedHeader = yield* Schema.encodeEffect(ContentHeaderCodec)(header)
      expect(encodedHeader).toEqual(payload(yield* encodeContentHeader(1, header.bodySize, header.properties)))
      const decodedHeader = yield* Schema.decodeEffect(ContentHeaderCodec)(encodedHeader)
      expect(decodedHeader).toMatchObject({ bodySize: header.bodySize, properties: header.properties })
      expect(decodedHeader.decodedCost).toBeGreaterThan(0)
    }))

  it("rejects invalid values directly through Schema before encoding and after binary parsing", () => {
    expect(Result.isFailure(Schema.encodeUnknownResult(FrameCodec)({ type: 8, channel: 1, payload: bytes() })))
      .toBe(true)
    expect(Result.isFailure(Schema.encodeUnknownResult(MethodCodec)({ classId: 60, methodId: 80, fields: {} })))
      .toBe(true)
    expect(
      Result.isFailure(Schema.encodeUnknownResult(MethodCodec)({ classId: 10, methodId: 51, fields: new Date(0) }))
    )
      .toBe(true)
    expect(Result.isFailure(Schema.encodeUnknownResult(MethodCodec)({ classId: 10, methodId: 51, fields: [] })))
      .toBe(true)
    expect(Result.isFailure(
      Schema.encodeUnknownResult(MethodCodec)({
        classId: 60,
        methodId: 80,
        fields: { deliveryTag: 1, multiple: false }
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.encodeUnknownResult(ContentHeaderCodec)({
        bodySize: 0n,
        properties: { priority: 256 },
        decodedCost: 0
      })
    )).toBe(true)
    expect(Result.isFailure(Schema.encodeUnknownResult(FieldTableCodec)({ invalid: Number.NaN }))).toBe(true)
    for (const schema of [FrameCodec, MethodCodec, ContentHeaderCodec, FieldTableCodec]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)("not bytes"))).toBe(true)
    }
    // The Reader can construct these scalars, but the codec's decoded-side constraints must reject them.
    const nan = tableEntry("d", bytes(127, 248, 0, 0, 0, 0, 0, 0))
    expect(Result.isFailure(Schema.decodeUnknownResult(ContentHeaderCodec)(tablePayload(nan)))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(MethodCodec)(bytes(0, 60, 0, 21, 1, 0)))).toBe(true)
  })

  it.effect("keeps binary failures in the typed channel with their exact wire reason and Schema cause", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(decodeMethod(bytes(0, 60, 0, 21, 3, 97)))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(AMQPProtocolError)
        expect(result.failure.reason).toBe("Truncated wire value")
        expect(Schema.isSchemaError(result.failure.cause)).toBe(true)
      }
      const invalid = yield* Effect.result(Schema.decodeUnknownEffect(MethodCodec)(null))
      expect(Result.isFailure(invalid)).toBe(true)
    }))

  it.effect("keeps allocation budgets inside configurable content-header Schema transformations", () =>
    Effect.gen(function*() {
      const encoded = payload(yield* encodeContentHeader(1, 0n, { headers: { value: "text" } }))
      const decoded = yield* decodeContentHeader(encoded)
      expect(Schema.decodeUnknownResult(makeContentHeaderCodec({ maxDecodedBytes: decoded.decodedCost }))(encoded))
        .toEqual(Result.succeed(decoded))
      const limited = Schema.decodeUnknownResult(makeContentHeaderCodec({ maxDecodedBytes: decoded.decodedCost - 1 }))(
        encoded
      )
      expect(Result.isFailure(limited)).toBe(true)
      yield* malformed(decodeContentHeader(encoded, { maxDecodedBytes: decoded.decodedCost - 1 }))
    }))

  it.effect("rejects malformed branded wrappers instead of treating them as ordinary field tables", () =>
    Effect.gen(function*() {
      const invalid = [
        { ...AMQPTypes.decimal(256, 1) },
        { [AMQPTypes.DecimalTypeId]: false, _tag: "Decimal", scale: 1, value: 1 },
        { ...AMQPTypes.fieldNumber("float", 1e100) },
        { [AMQPTypes.LongStringTypeId]: AMQPTypes.LongStringTypeId, bytes: "not bytes" }
      ]
      for (const value of invalid) {
        expect(Result.isFailure(Schema.encodeUnknownResult(FieldTableCodec)({ value }))).toBe(true)
      }
      expect(
        (yield* decodeContentHeader(payload(
          yield* encodeContentHeader(1, 0n, {
            headers: { value: { _tag: "Decimal", scale: 256, value: -1 } }
          })
        ))).properties.headers?.value
      ).toEqual({ _tag: "Decimal", scale: 256, value: -1 })
    }))

  it.effect("normalizes convenience properties without changing timestamp bits or emitting undefined fields", () =>
    Effect.gen(function*() {
      const encoding: Effect.Effect<Uint8Array, AMQPProtocolError> = Reflect.apply(encodeContentHeader, undefined, [
        1,
        0n,
        {
          timestamp: Number.MAX_SAFE_INTEGER,
          expiration: 1000,
          priority: undefined
        }
      ])
      const encoded = yield* encoding
      expect((yield* decodeContentHeader(payload(encoded))).properties).toEqual({
        timestamp: BigInt(Number.MAX_SAFE_INTEGER),
        expiration: "1000"
      })
      yield* schemaFailure(encodeContentHeader(1, 0n, { timestamp: Number.MAX_SAFE_INTEGER + 1 }))
      yield* schemaFailure(encodeContentHeader(1, 0n, { expiration: Number.NaN }))
    }))

  it.effect("rejects oversized text in Schema before allocating a TextEncoder buffer", () =>
    Effect.gen(function*() {
      const oversized = "a".repeat(16 * 1024 * 1024 + 1)
      const encode = vi.spyOn(TextEncoder.prototype, "encode")
      try {
        yield* schemaFailure(encodeFieldTable({ oversized }))
        yield* schemaFailure(encodeMethod(0, 10, 70, { newSecret: oversized }))
        expect(encode).not.toHaveBeenCalled()
      } finally {
        encode.mockRestore()
      }
    }))

  it.effect("charges method byte fields before copying their payload", () =>
    Effect.gen(function*() {
      // Independent connection.update-secret payload: class, method, long bytes, empty short reason.
      const length = MAX_DECODED_BYTES + 1
      const encoded = new Uint8Array(4 + 4 + length + 1)
      encoded.set([0, 10, 0, 70])
      new DataView(encoded.buffer).setUint32(4, length)
      const result = yield* Effect.result(decodeMethod(encoded))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe("Decoded wire value exceeds memory limit")
        expect(Schema.isSchemaError(result.failure.cause)).toBe(true)
      }
    }))

  it.effect("reports Schema failures for invalid external encode inputs rather than unchecked writer errors", () =>
    Effect.gen(function*() {
      yield* schemaFailure(Reflect.apply(encodeFrame, undefined, [3, 1, null]))
      yield* schemaFailure(encodeMethod(0, 10, 30, { heartbeat: -1 }))
      yield* schemaFailure(encodeContentHeader(1, 0n, { priority: 256 }))
      yield* schemaFailure(encodeFieldTable({ invalid: Number.NaN }))
    }))

  it.effect("reports Schema failures for invalid external wire inputs and binary decoding failures", () =>
    Effect.gen(function*() {
      yield* schemaFailure(Reflect.apply(decodeMethod, undefined, [new ArrayBuffer(4)]))
      yield* schemaFailure(Reflect.apply(decodeContentHeader, undefined, [null]))
      yield* schemaFailure(decodeMethod(bytes(0, 60, 0, 21, 3, 97)))
      yield* schemaFailure(decodeContentHeader(bytes(0, 61)))
    }))

  it.effect("matches the protocol header and specification method golden bytes", () =>
    Effect.gen(function*() {
      expect(PROTOCOL_HEADER).toEqual(bytes(65, 77, 81, 80, 0, 0, 9, 1))
      expect(yield* encodeMethod(0, 10, 31, { channelMax: 2047, frameMax: 131072, heartbeat: 60 })).toEqual(
        bytes(1, 0, 0, 0, 0, 0, 12, 0, 10, 0, 31, 7, 255, 0, 2, 0, 0, 0, 60, 206)
      )
      expect(yield* encodeMethod(1, 60, 10, { prefetchCount: 10, global: true })).toEqual(
        bytes(1, 0, 1, 0, 0, 0, 11, 0, 60, 0, 10, 0, 0, 0, 0, 0, 10, 1, 206)
      )
      expect(yield* encodeMethod(1, 60, 40, { exchange: "x", routingKey: "rk", mandatory: true })).toEqual(
        bytes(1, 0, 1, 0, 0, 0, 12, 0, 60, 0, 40, 0, 0, 1, 120, 2, 114, 107, 1, 206)
      )
      expect(yield* encodeMethod(1, 50, 10, { queue: "q", durable: true, exclusive: true })).toEqual(
        bytes(1, 0, 1, 0, 0, 0, 13, 0, 50, 0, 10, 0, 0, 1, 113, 6, 0, 0, 0, 0, 206)
      )
      expect(yield* encodeFrame(8, 0, bytes())).toEqual(bytes(8, 0, 0, 0, 0, 0, 0, 206))
    }))

  it.effect("encodes and decodes every supported method with protocol defaults", () =>
    Effect.gen(function*() {
      const methods: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
        [10, [10, 11, 30, 31, 40, 41, 50, 51, 60, 61, 70, 71]],
        [20, [10, 11, 20, 21, 40, 41]],
        [40, [10, 11, 20, 21, 30, 31, 40, 51]],
        [50, [10, 11, 20, 21, 30, 31, 40, 41, 50, 51]],
        [60, [10, 11, 20, 21, 30, 31, 40, 50, 60, 70, 71, 72, 80, 90, 100, 110, 111, 120]],
        [85, [10, 11]]
      ]
      for (const [classId, ids] of methods) {
        for (const methodId of ids) {
          const encoded = yield* encodeMethod(1, classId, methodId)
          const decoded = yield* decodeMethod(payload(encoded))
          expect(decoded.classId).toBe(classId)
          expect(decoded.methodId).toBe(methodId)
          expect(yield* encodeMethod(1, classId, methodId, decoded.fields)).toEqual(encoded)
        }
      }
    }))

  it.effect("keeps all 64 delivery-tag bits and packs adjacent flags", () =>
    Effect.gen(function*() {
      const tag = 0xffffffffffffffffn
      const frame = yield* encodeMethod(65535, 60, 120, { deliveryTag: tag, multiple: true, requeue: true })
      expect(payload(frame)).toEqual(bytes(0, 60, 0, 120, 255, 255, 255, 255, 255, 255, 255, 255, 3))
      expect((yield* decodeMethod(payload(frame))).fields).toEqual({ deliveryTag: tag, multiple: true, requeue: true })
      const delivery = {
        consumerTag: "ct",
        deliveryTag: 0x8000000000000000n,
        redelivered: true,
        exchange: "e",
        routingKey: "r"
      }
      expect((yield* decodeMethod(payload(yield* encodeMethod(2, 60, 60, delivery)))).fields).toEqual(delivery)
      yield* malformed(encodeMethod(1, 60, 80, { deliveryTag: -1n }))
      yield* malformed(encodeMethod(1, 60, 80, { deliveryTag: 1n << 64n }))
      yield* malformed(encodeMethod(1, 60, 80, { deliveryTag: Number.MAX_SAFE_INTEGER + 1 }))
    }))

  it.effect("decodes textual negotiation long strings and preserves binary secrets", () =>
    Effect.gen(function*() {
      const start = yield* decodeMethod(payload(
        yield* encodeMethod(0, 10, 10, {
          serverProperties: { product: "broker" },
          mechanisms: "PLAIN EXTERNAL",
          locales: "en_US"
        })
      ))
      expect(start.fields.mechanisms).toBe("PLAIN EXTERNAL")
      expect(start.fields.locales).toBe("en_US")
      const response = bytes(0, 255, 0, 254)
      expect((yield* decodeMethod(payload(yield* encodeMethod(0, 10, 11, { response })))).fields.response).toEqual(
        response
      )
      expect(
        (yield* decodeMethod(payload(yield* encodeMethod(0, 10, 70, { newSecret: "secret", reason: "rotation" }))))
          .fields
      )
        .toEqual({ newSecret: new TextEncoder().encode("secret"), reason: "rotation" })
    }))

  it.effect("matches content header golden bytes and preserves large body sizes", () =>
    Effect.gen(function*() {
      expect(yield* encodeContentHeader(1, 3n, { contentType: "a", deliveryMode: 2 })).toEqual(
        bytes(2, 0, 1, 0, 0, 0, 17, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 144, 0, 1, 97, 2, 206)
      )
      const properties: AMQPTypes.MessageProperties = {
        contentType: "application/json",
        contentEncoding: "utf-8",
        headers: { tracing: "abc" },
        deliveryMode: 2,
        priority: 0,
        correlationId: "c",
        replyTo: "q",
        expiration: "1000",
        messageId: "m",
        timestamp: 0xffffffffffffffffn,
        type: "event",
        userId: "guest",
        appId: "app",
        clusterId: "cluster"
      }
      expect(yield* decodeContentHeader(payload(yield* encodeContentHeader(1, 0xffffffffffffffffn, properties))))
        .toMatchObject({ bodySize: 0xffffffffffffffffn, properties })
      expect(
        (yield* decodeContentHeader(payload(yield* encodeContentHeader(1, 0n, { expiration: 5000 })))).properties
          .expiration
      )
        .toBe("5000")
    }))

  it.effect("round-trips nested field tables, decimals, byte arrays, dates and null", () =>
    Effect.gen(function*() {
      const table: AMQPTypes.FieldTable = {
        text: "你好",
        yes: true,
        no: false,
        empty: null,
        small: -128,
        medium: -32768,
        large: -2147483648,
        signed: -0x8000000000000000n,
        maximum: 0x7fffffffffffffffn,
        fraction: AMQPTypes.fieldNumber("double", 1.25),
        decimal: AMQPTypes.decimal(2, 0xffffffff),
        binary: bytes(0, 255),
        date: new Date("2026-09-30T00:00:00Z"),
        nested: { array: ["a", true, null, { inner: 5 }] }
      }
      const result = yield* decodeContentHeader(payload(yield* encodeContentHeader(1, 0n, { headers: table })))
      expect(result.properties.headers).toEqual(table)
      const copied = result.properties.headers!.binary as Uint8Array
      expect(copied).not.toBe(table.binary)
      const grown = { many: "x".repeat(1000), last: 127 }
      expect(
        (yield* decodeContentHeader(payload(yield* encodeContentHeader(1, 0n, { headers: grown })))).properties.headers
      )
        .toEqual(grown)
    }))

  it.effect("handles signed and unsigned wire field tags independently", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, Uint8Array, AMQPTypes.FieldValue]> = [
        ["b", bytes(255), -1],
        ["B", bytes(255), 255],
        ["s", bytes(255, 255), -1],
        ["U", bytes(128, 0), -32768],
        ["u", bytes(255, 255), 65535],
        ["I", bytes(255, 255, 255, 255), -1],
        ["i", bytes(255, 255, 255, 255), 4294967295],
        ["l", bytes(255, 255, 255, 255, 255, 255, 255, 255), -1n],
        ["L", bytes(255, 255, 255, 255, 255, 255, 255, 255), -1n],
        ["f", bytes(63, 160, 0, 0), AMQPTypes.fieldNumber("float", 1.25)]
      ]
      for (const [tag, value, expected] of cases) {
        expect((yield* decodeContentHeader(tablePayload(tableEntry(tag, value)))).properties.headers!.a).toEqual(
          expected
        )
      }
    }))

  it.effect("retains pollution-sensitive keys without mutating object prototypes", () =>
    Effect.gen(function*() {
      const headers = Object.create(null) as Record<string, AMQPTypes.FieldValue>
      headers.__proto__ = { polluted: true }
      Object.defineProperty(headers, "constructor", { value: "ordinary value", enumerable: true })
      headers.prototype = 42
      const decoded = (yield* decodeContentHeader(payload(yield* encodeContentHeader(1, 0n, { headers })))).properties
        .headers!
      expect(Object.getPrototypeOf(decoded)).toBeNull()
      expect(Object.hasOwn(decoded, "__proto__")).toBe(true)
      expect(decoded.__proto__).toEqual({ polluted: true })
      expect(decoded.constructor).toBe("ordinary value")
      expect(Object.hasOwn({}, "polluted")).toBe(false)
    }))

  it.effect("supports every two-chunk split and bytewise fragmentation", () =>
    Effect.gen(function*() {
      const frame = yield* encodeMethod(42, 60, 60, {
        consumerTag: "test",
        deliveryTag: 0xffffffffffffffffn,
        exchange: "e",
        routingKey: "r"
      })
      for (let split = 0; split <= frame.length; split++) {
        const decoder = yield* makeFrameDecoder()
        const frames: Array<Codec.Frame> = []
        const consume = (frame: Codec.Frame) =>
          Effect.sync(() => {
            frames.push(frame)
            return true
          })
        yield* decoder.feed(frame.subarray(0, split), consume)
        yield* decoder.feed(frame.subarray(split), consume)
        expect(frames).toEqual([{ type: 1, channel: 42, payload: payload(frame) }])
        yield* decoder.end()
      }
      const decoder = yield* makeFrameDecoder()
      const frames: Array<Codec.Frame> = []
      for (const byte of frame) {
        yield* decoder.feed(bytes(byte), (frame) =>
          Effect.sync(() => {
            frames.push(frame)
            return true
          }))
      }
      expect(frames).toHaveLength(1)
      expect(frames[0].payload).toEqual(payload(frame))
      yield* decoder.end()
    }))

  it.effect("coalesces frames and owns payload bytes independently of input", () =>
    Effect.gen(function*() {
      const body = bytes(1, 2, 3)
      const input = concat(
        yield* encodeFrame(8, 0, bytes()),
        yield* encodeFrame(3, 1, body),
        yield* encodeMethod(1, 85, 11)
      )
      const decoder = yield* makeFrameDecoder(16, 16)
      const frames: Array<Codec.Frame> = []
      yield* decoder.feed(input, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
          return true
        }))
      expect(frames.map((frame) => frame.type)).toEqual([8, 3, 1])
      input.fill(0)
      expect(frames[1].payload).toEqual(body)
      yield* decoder.end()
    }))

  it.effect("rejects oversized and malformed frames before buffering payloads", () =>
    Effect.gen(function*() {
      yield* malformed((yield* makeFrameDecoder(16)).feed(bytes(3, 0, 1, 0, 0, 0, 9), () => Effect.succeed(true)))
      yield* malformed((yield* makeFrameDecoder(100, 16)).feed(bytes(3, 0, 1, 0, 0, 0, 9), () => Effect.succeed(true)))
      yield* malformed(
        (yield* makeFrameDecoder(0)).feed(bytes(3, 0, 1, 255, 255, 255, 255), () => Effect.succeed(true))
      )
      yield* malformed((yield* makeFrameDecoder()).feed(bytes(4, 0, 0, 0, 0, 0, 0), () => Effect.succeed(true)))
      yield* malformed((yield* makeFrameDecoder()).feed(bytes(8, 0, 1, 0, 0, 0, 0), () => Effect.succeed(true)))
      yield* malformed((yield* makeFrameDecoder()).feed(bytes(8, 0, 0, 0, 0, 0, 1), () => Effect.succeed(true)))
      yield* malformed((yield* makeFrameDecoder()).feed(bytes(3, 0, 1, 0, 0, 0, 0, 0), () => Effect.succeed(true)))
      yield* malformed(encodeFrame(4, 0, bytes()))
      yield* malformed(encodeFrame(8, 1, bytes()))
      yield* malformed(encodeFrame(8, 0, bytes(1)))
      yield* malformed(encodeFrame(3, 65536, bytes()))
      const complete = yield* encodeFrame(3, 1, bytes(1, 2, 3))
      for (let size = 1; size < complete.length; size++) {
        const decoder = yield* makeFrameDecoder()
        yield* decoder.feed(complete.subarray(0, size), () => Effect.succeed(true))
        yield* malformed(decoder.end())
      }
    }))

  it.effect("validates UTF-8, short string byte limits and method ranges", () =>
    Effect.gen(function*() {
      expect(
        (yield* decodeMethod(payload(yield* encodeMethod(1, 60, 21, { consumerTag: "é".repeat(127) })))).fields
          .consumerTag
      )
        .toBe("é".repeat(127))
      yield* malformed(encodeMethod(1, 60, 21, { consumerTag: "é".repeat(128) }))
      yield* malformed(encodeMethod(1, 60, 21, { consumerTag: "\ud800" }))
      yield* malformed(encodeMethod(1, 60, 21, { consumerTag: "a\u0000b" }))
      yield* malformed(decodeMethod(bytes(0, 60, 0, 21, 1, 0)))
      yield* malformed(decodeMethod(bytes(0, 60, 0, 21, 2, 192, 175)))
      yield* malformed(decodeMethod(bytes(0, 60, 0, 21, 1, 255)))
      yield* malformed(decodeMethod(bytes(0, 60, 0, 21, 3, 97)))
      yield* malformed(encodeMethod(0, 10, 30, { channelMax: 65536 }))
      yield* malformed(encodeMethod(0, 10, 30, { heartbeat: -1 }))
      yield* malformed(encodeMethod(0, 10, 30, { frameMax: 1.5 }))
      yield* malformed(encodeMethod(1, 60, 10, { global: 1 }))
      yield* malformed(encodeMethod(1, 99, 10))
      yield* malformed(decodeMethod(bytes(0, 99, 0, 10)))
      yield* malformed(decodeMethod(bytes(0, 85, 0, 11, 0)))
      yield* malformed(decodeMethod(bytes(0, 85, 0, 10, 2)))
    }))

  it.effect("rejects invalid content classes, weights, flags and trailing data", () =>
    Effect.gen(function*() {
      const valid = payload(yield* encodeContentHeader(1, 0n, {}))
      for (const [offset, value] of [[1, 61], [3, 1], [13, 1], [13, 2]]) {
        const invalid = valid.slice()
        invalid[offset] = value
        yield* malformed(decodeContentHeader(invalid))
      }
      yield* malformed(decodeContentHeader(concat(valid, bytes(0))))
      yield* malformed(decodeContentHeader(valid.subarray(0, valid.length - 1)))
      yield* malformed(encodeContentHeader(1, -1n, {}))
      yield* malformed(encodeContentHeader(1, 0n, { priority: 256 }))
    }))

  it.effect("rejects bad field tags, invalid lengths, duplicate keys and excessive nesting", () =>
    Effect.gen(function*() {
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("?", bytes()))))
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("t", bytes(2)))))
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("S", bytes(0, 0, 0, 2, 97)))))
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("S", bytes(255, 255, 255, 255)))))
      expect((yield* decodeContentHeader(tablePayload(tableEntry("S", bytes(0, 0, 0, 1, 255))))).properties.headers!.a)
        .toEqual(AMQPTypes.longString(bytes(255)))
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("A", bytes(0, 0, 0, 2, 73, 1)))))
      yield* malformed(decodeContentHeader(tablePayload(tableEntry("F", bytes(0, 0, 0, 1, 1)))))
      yield* malformed(
        decodeContentHeader(tablePayload(tableEntry("T", bytes(255, 255, 255, 255, 255, 255, 255, 255))))
      )
      yield* malformed(decodeContentHeader(tablePayload(concat(tableEntry("V", bytes()), tableEntry("V", bytes())))))
      let nested: AMQPTypes.FieldValue = null
      for (let i = 0; i < 40; i++) nested = { nested }
      yield* malformed(encodeContentHeader(1, 0n, { headers: { nested } }))
      const cyclic: Record<string, AMQPTypes.FieldValue> = {}
      cyclic.self = cyclic
      yield* malformed(encodeContentHeader(1, 0n, { headers: cyclic }))
      yield* malformed(encodeContentHeader(1, 0n, { headers: { invalid: Number.NaN } }))
      yield* malformed(encodeContentHeader(1, 0n, { headers: { invalid: 0xffffffffffffffffn } }))
      yield* malformed(encodeContentHeader(1, 0n, { headers: { invalid: AMQPTypes.decimal(2, -1) } }))
      yield* malformed(encodeContentHeader(1, 0n, { headers: { invalid: new Date(Number.NaN) } }))
      let nestedWire = tableEntry("V", bytes())
      for (let i = 0; i < 40; i++) {
        const length = new Uint8Array(4)
        new DataView(length.buffer).setUint32(0, nestedWire.length)
        nestedWire = tableEntry("F", concat(length, nestedWire))
      }
      yield* malformed(decodeContentHeader(tablePayload(nestedWire)))
    }))
})
