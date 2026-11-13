import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPPublisher from "../src/AMQPPublisher.ts"
import { expectFailure } from "./assertions.ts"
import { encode, testConfirmChannel } from "./dependencies.ts"

describe("AMQPPublisher", () => {
  it.live("snapshots user headers once before tracing and publication", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const publisher = yield* AMQPPublisher.make()
      let reads = 0
      const headers = {
        get value() {
          return ++reads === 1 ? 1 : NaN
        }
      }
      yield* publisher.publish({
        exchange: "",
        routingKey: queue.queue,
        content: encode("snapshot"),
        options: { headers }
      })
      expect(reads).toBe(1)
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isNone(message)) return
      expect(message.value.properties.headers?.value).toBe(1)
      yield* channel.ack(message.value)
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("maps foreign publication reflection failures to typed publisher errors before admission", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const publisher = yield* AMQPPublisher.make()
      const foreign = Proxy.revocable({ headers: {} }, {})
      foreign.revoke()
      const input = {
        exchange: "",
        routingKey: queue.queue,
        content: encode("not sent"),
        get options() {
          return Reflect.get(foreign.proxy, "headers")
        }
      }
      expectFailure(yield* Effect.exit(publisher.publish(input)), {
        _tag: "PublisherError",
        reason: expect.stringContaining("Failed to publish")
      })
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.provide(testConfirmChannel)))

  it.live("propagates trace context without converting numeric or binary headers to HTTP headers", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const publisher = yield* AMQPPublisher.make()
      yield* publisher.publish({
        exchange: "",
        routingKey: queue.queue,
        content: encode("event"),
        options: { headers: { count: 42, binary: new Uint8Array([0, 255]) } }
      })
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isSome(message)) {
        expect(message.value.properties.headers?.count).toBe(42)
        expect(message.value.properties.headers?.binary).toEqual(new Uint8Array([0, 255]))
        expect(message.value.properties.headers?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
        yield* channel.ack(message.value)
      }
    }).pipe(Effect.provide(testConfirmChannel)))
})
