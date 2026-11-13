import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Result, Stream } from "effect"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { broker, encode } from "./dependencies.ts"
import { makeBroker, nextMethod, type Session } from "./syntheticBroker.ts"

const deliver = Effect.fnUntraced(function*(session: Session, channel: number, tag: number) {
  yield* session.reply(channel, 60, 60, {
    consumerTag: "synthetic-consumer",
    deliveryTag: BigInt(tag),
    redelivered: false,
    exchange: "",
    routingKey: "queue"
  })
  yield* session.send(yield* Codec.encodeContentHeader(channel, BigInt(0), {}))
})

describe("automatic acknowledgement", () => {
  it.effect("snapshots inherited get flags once and rejects invalid acknowledgement flags locally", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      let reads = 0
      class GetOptions {
        get noAck() {
          return ++reads === 1
        }
      }
      const get = yield* channel.get("queue", new GetOptions()).pipe(Effect.forkScoped)
      const request = yield* nextMethod(session, 60, 70)
      expect(request.fields.noAck).toBe(true)
      yield* session.reply(request.channel, 60, 72)
      expect(Option.isNone(yield* Fiber.join(get))).toBe(true)
      expect(reads).toBe(1)
      const malformed = Object.defineProperty({}, "noAck", { value: "invalid", enumerable: true })
      const result = yield* Effect.result(channel.get("queue", malformed))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("AMQPProtocolError")
    })))

  it.effect("retires an overflowing bounded auto-ack consumer visibly without blocking reader controls", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0, shutdownTimeout: "100 millis" })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ prefetch: 0 })
      const stream = yield* channel.consume("queue", { noAck: true, maxBufferedMessages: 1 })
      const registration = yield* nextMethod(session, 60, 20)
      yield* deliver(session, registration.channel, 1)
      yield* deliver(session, registration.channel, 2)
      let cancellation
      while (cancellation === undefined) {
        const method = yield* Queue.take(session.methods)
        expect(method.classId === 60 && method.methodId === 90).toBe(false)
        if (method.classId === 60 && method.methodId === 30) cancellation = method
      }
      expect(cancellation.fields.noWait).toBe(false)
      const result = yield* Effect.result(Stream.runDrain(stream))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) && result.failure._tag === "AMQPChannelError") {
        expect(result.failure.reason).toContain("maxBufferedMessages")
      }
      yield* channel.prefetch(2)
    })))

  it.effect("passes get noAck and rejects all individual settlement locally", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const get = yield* channel.get("queue", { noAck: true }).pipe(Effect.forkScoped)
      const request = yield* nextMethod(session, 60, 70)
      expect(request.fields.noAck).toBe(true)
      yield* session.reply(request.channel, 60, 71, {
        deliveryTag: BigInt(1),
        redelivered: false,
        exchange: "",
        routingKey: "queue",
        messageCount: 0
      })
      yield* session.send(yield* Codec.encodeContentHeader(request.channel, BigInt(0), {}))
      const message = Option.getOrThrow(yield* Fiber.join(get))
      for (const settle of [channel.ack(message), channel.nack(message), channel.reject(message)]) {
        const result = yield* Effect.result(settle)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result) && result.failure._tag === "AMQPSettlementError") {
          expect(result.failure.kind).toBe("AutoAcknowledged")
        }
      }
    })))

  it.effect("requires automatic acknowledgement for Direct Reply-To", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const channel = yield* connection.createChannel()
      expect(Result.isFailure(yield* Effect.result(channel.consume("amq.rabbitmq.reply-to")))).toBe(true)
      yield* channel.consume("amq.rabbitmq.reply-to", { noAck: true, noLocal: true }).pipe(Effect.asVoid)
      const session = yield* Queue.take(broker.sessions)
      const request = yield* nextMethod(session, 60, 20)
      expect(request.fields.noAck).toBe(true)
      expect(request.fields.noLocal).toBe(true)
    })))

  it.live("performs actual Direct Reply-To request/response on the requester's channel", () =>
    Effect.scoped(Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(broker)
      const requester = yield* connection.createChannel()
      const responder = yield* connection.createChannel()
      const queue = yield* responder.assertQueue("", { exclusive: true, autoDelete: true, durable: false })
      const responses = yield* requester.consume("amq.rabbitmq.reply-to", { noAck: true })
      const response = yield* responses.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const requests = yield* responder.consume(queue, { noAck: true })
      const serving = yield* requests.pipe(
        Stream.take(1),
        Stream.runForEach((request) =>
          responder.publish("", request.properties.replyTo ?? "", encode("response"), { headers: {} })
        ),
        Effect.forkScoped
      )
      yield* requester.sendToQueue(queue, encode("request"), { replyTo: "amq.rabbitmq.reply-to", headers: {} })
      expect((yield* Fiber.join(response))[0]?.content).toEqual(encode("response"))
      yield* Fiber.join(serving)
    })).pipe(Effect.timeout("10 seconds")))
})
