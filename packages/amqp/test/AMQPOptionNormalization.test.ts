import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { AMQPProtocolError } from "../src/AMQPError.ts"
import * as Codec from "../src/internal/codec.ts"
import * as Normalize from "../src/internal/normalizeOptions.ts"

describe("AMQP option normalization", () => {
  it.effect("preserves amqplib's boolean deliveryMode convenience without broadening decoded properties", () =>
    Effect.gen(function*() {
      expect((yield* Normalize.publish({ deliveryMode: true })).deliveryMode).toBe(2)
      expect((yield* Normalize.publish({ deliveryMode: false })).deliveryMode).toBe(1)
      expect((yield* Normalize.publish({ deliveryMode: true, persistent: false })).deliveryMode).toBe(1)
      expect((yield* Normalize.publish({ deliveryMode: false, persistent: true })).deliveryMode).toBe(2)
    }))

  it.effect("applies convenience aliases before validating shadowed legacy scalar wrappers", () =>
    Effect.gen(function*() {
      const invalid = { "!": "uint8", value: 256 }
      expect((yield* Normalize.queue({ messageTtl: 0, arguments: { "x-message-ttl": invalid } })).arguments)
        .toEqual({ "x-message-ttl": 0 })
      expect((yield* Normalize.publish({ CC: "route", headers: { CC: invalid } })).headers).toEqual({ CC: ["route"] })
      expect((yield* Normalize.consume({ priority: 0, arguments: { "x-priority": invalid } })).arguments)
        .toEqual({ "x-priority": 0 })
      expect(Result.isFailure(yield* Effect.result(Normalize.queue({ arguments: { invalid } })))).toBe(true)
    }))
  it.effect("accepts absent publication options and headers without requiring a dummy field table", () =>
    Effect.gen(function*() {
      expect(yield* Normalize.publish({})).not.toHaveProperty("headers")
      expect(yield* Normalize.publish({ mandatory: true })).not.toHaveProperty("headers")
      expect((yield* Normalize.publish({ CC: "copy" })).headers).toEqual({ CC: ["copy"] })
    }))

  it.effect("reads inherited named options and enumerable extension tables once with own shadowing", () =>
    Effect.gen(function*() {
      let reads = 0
      const arguments_ = Object.create({ inherited: 1, masked: 2, "x-message-ttl": 99 })
      arguments_.masked = undefined
      const base = {
        get messageTtl() {
          return ++reads === 1 ? 0 : NaN
        },
        arguments: arguments_
      }
      const options = Object.create(base)
      Object.defineProperty(options, "messageTtl", { value: undefined, enumerable: true })
      expect((yield* Normalize.queue(options)).arguments).toEqual({ inherited: 1, "x-message-ttl": 99 })
      expect(reads).toBe(0)
      const inherited = yield* Normalize.queue(Object.create(base))
      expect(inherited.arguments).toEqual({ inherited: 1, "x-message-ttl": 0 })
      expect(reads).toBe(1)
      const headers = Object.create({ inherited: true, CC: ["raw"], hidden: "masked" })
      headers.hidden = undefined
      const publish = Object.create({ headers, CC: "route" })
      Object.defineProperty(publish, "persistent", { value: false })
      expect(yield* Normalize.publish(publish)).toMatchObject({
        headers: { inherited: true, CC: ["route"] },
        deliveryMode: 1
      })
      const consume = yield* Normalize.consume(
        Object.create({ priority: 10, noLocal: true, noAck: false, prefetch: 0, arguments: { "x-priority": -1 } })
      )
      expect(consume).toMatchObject({ noLocal: true, noAck: false, prefetch: 0, arguments: { "x-priority": 10 } })
    }))

  it.effect("lets defined queue aliases override raw arguments, retaining unknown extension keys", () =>
    Effect.gen(function*() {
      const normalized = yield* Normalize.queue({
        messageTtl: 0,
        expires: 1000,
        deadLetterExchange: "",
        deadLetterRoutingKey: "failed",
        maxLength: 0,
        maxLengthBytes: 1024,
        maxPriority: 0,
        overflow: "reject-publish",
        singleActiveConsumer: false,
        queueMode: "lazy",
        queueType: "quorum",
        consumerTimeout: 60000,
        arguments: { "x-message-ttl": 99, "x-single-active-consumer": true, custom: [1, "value"] }
      })
      expect(normalized.arguments).toEqual({
        "x-message-ttl": 0,
        "x-expires": 1000,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": "failed",
        "x-max-length": 0,
        "x-max-length-bytes": 1024,
        "x-max-priority": 0,
        "x-overflow": "reject-publish",
        "x-single-active-consumer": false,
        "x-queue-mode": "lazy",
        "x-queue-type": "quorum",
        "x-consumer-timeout": 60000,
        custom: [1, "value"]
      })
      expect((yield* Normalize.queue({ arguments: { "x-message-ttl": 12 } })).arguments).toEqual({
        "x-message-ttl": 12
      })
      expect(
        (yield* Normalize.exchange({ alternateExchange: "", arguments: { "alternate-exchange": "raw", x: 1 } }))
          .arguments
      )
        .toEqual({ "alternate-exchange": "", x: 1 })
      expect((yield* Normalize.queue({ messageTtl: 0, arguments: { "x-message-ttl": NaN } })).arguments)
        .toEqual({ "x-message-ttl": 0 })
    }))

  it.effect("normalizes CC/BCC to S-string arrays with exact override precedence and duplicate preservation", () =>
    Effect.gen(function*() {
      const normalized = yield* Normalize.publish({
        CC: ["one", "one", "two"],
        BCC: "hidden",
        persistent: false,
        deliveryMode: 2,
        expiration: 0,
        timestamp: 123,
        headers: { CC: ["raw"], BCC: ["raw"], custom: true }
      })
      expect(normalized.headers).toEqual({ CC: ["one", "one", "two"], BCC: ["hidden"], custom: true })
      expect(normalized.deliveryMode).toBe(1)
      expect(normalized.expiration).toBe("0")
      expect(normalized.timestamp).toBe(123n)
      const frame = yield* Codec.encodeContentHeader(1, 0n, normalized)
      expect((yield* Codec.decodeContentHeader(frame.subarray(7, frame.length - 1))).properties.headers)
        .toEqual(normalized.headers)
      expect((yield* Normalize.publish({ headers: { CC: ["raw"] } })).headers).toEqual({ CC: ["raw"] })
      expect((yield* Normalize.publish({ CC: [], headers: { CC: ["raw"] } })).headers).toEqual({ CC: [] })
      expect(
        (yield* Normalize.publish({ CC: "one", persistent: false, deliveryMode: 256, headers: { CC: NaN } })).headers
      )
        .toEqual({ CC: ["one"] })
    }))

  it.effect("snapshots named caller getters once per execution and ignores unknown top-level options", () =>
    Effect.gen(function*() {
      let ttlReads = 0
      let valueReads = 0
      const options = {
        get messageTtl() {
          return ++ttlReads
        },
        arguments: {
          get value() {
            return ++valueReads
          }
        },
        extra: { value: "retained" }
      }
      const effect = Normalize.queue(options)
      const first = yield* effect
      expect(first.arguments).toEqual({ value: 1, "x-message-ttl": 1 })
      expect(first).not.toHaveProperty("extra")
      expect(yield* effect).toMatchObject({ arguments: { value: 2, "x-message-ttl": 2 } })
      expect(ttlReads).toBe(2)
      expect(valueReads).toBe(2)
    }))

  it.effect("returns foreign reflection failures as typed Schema-backed protocol errors", () =>
    Effect.gen(function*() {
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      const effects: Array<Effect.Effect<unknown, AMQPProtocolError>> = [
        Normalize.queue(revoked.proxy),
        Normalize.exchange(revoked.proxy),
        Normalize.publish(revoked.proxy)
      ]
      for (const effect of effects) {
        const result = yield* Effect.result(effect)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(AMQPProtocolError)
          expect(Schema.isSchemaError(result.failure.cause)).toBe(true)
        }
      }
    }))

  it.effect("takes a single publish snapshot before overriding and validating headers", () =>
    Effect.gen(function*() {
      let ccReads = 0
      let headerReads = 0
      const options = {
        get CC() {
          return ++ccReads === 1 ? "route" : "different"
        },
        headers: {
          get value() {
            return ++headerReads === 1 ? 1 : NaN
          }
        }
      }
      const normalized = yield* Normalize.publish(options)
      expect(normalized.headers).toEqual({ value: 1, CC: ["route"] })
      expect(ccReads).toBe(1)
      expect(headerReads).toBe(1)
    }))
})
