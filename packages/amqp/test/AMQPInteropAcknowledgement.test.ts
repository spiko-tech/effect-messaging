import { describe, expect, it } from "@effect/vitest"
import * as Reference from "amqplib"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { AMQPConnectionError } from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import { expectFailure } from "./assertions.ts"
import { broker, encode } from "./dependencies.ts"

const external = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(evaluate()),
    catch: (cause) => new AMQPConnectionError({ reason: "Pinned amqplib interoperability operation failed", cause })
  })
const peer = Effect.gen(function*() {
  const connection = yield* Effect.acquireRelease(
    external(() => Reference.connect(broker)),
    (connection) => external(() => connection.close()).pipe(Effect.ignore)
  )
  return yield* Effect.acquireRelease(
    external(() => connection.createChannel()),
    (channel) => external(() => channel.close()).pipe(Effect.ignore)
  )
})
const queue = Effect.fnUntraced(function*(reference: Reference.Channel) {
  const name = `effect-noack-${randomUUID()}`
  yield* Effect.addFinalizer(() => external(() => reference.deleteQueue(name)).pipe(Effect.ignore))
  return yield* external(() => reference.assertQueue(name, { durable: true }))
})

describe("AMQP genuine automatic acknowledgement and Direct Reply-To interoperability", () => {
  it.live(
    "basic.get noAck removes the delivery at the broker without a later settlement",
    () =>
      Effect.gen(function*() {
        const reference = yield* peer
        const target = yield* queue(reference)
        const connection = yield* AMQPNodeConnection.make(broker)
        const channel = yield* connection.createChannel({ confirm: true })
        yield* channel.sendToQueue(target.queue, encode("automatic get"))
        const delivery = yield* channel.get(target.queue, { noAck: true })
        expect(Option.isSome(delivery)).toBe(true)
        if (Option.isNone(delivery)) return
        expect(delivery.value.content).toEqual(encode("automatic get"))
        expectFailure(yield* Effect.exit(channel.ack(delivery.value)), {
          _tag: "AMQPSettlementError",
          kind: "AutoAcknowledged"
        })
        expect((yield* channel.checkQueue(target.queue)).messageCount).toBe(0)
        yield* channel.close
        expect(yield* external(() => reference.get(target.queue))).toBe(false)
      }).pipe(Effect.scoped),
    15000
  )

  it.live(
    "consume noAck delivers beyond manual prefetch credit and never redelivers after channel closure",
    () =>
      Effect.gen(function*() {
        const reference = yield* peer
        const target = yield* queue(reference)
        const connection = yield* AMQPNodeConnection.make(broker)
        const channel = yield* connection.createChannel({ confirm: true })
        for (const body of ["one", "two", "three"]) yield* channel.sendToQueue(target.queue, encode(body))
        const messages = yield* channel.consume(target.queue, { noAck: true, prefetch: 1, maxBufferedMessages: 4 })
        const delivered = yield* messages.pipe(Stream.take(3), Stream.runCollect)
        expect(delivered.map((message) => new TextDecoder().decode(message.content))).toEqual(["one", "two", "three"])
        for (const message of delivered) {
          expectFailure(yield* Effect.exit(channel.reject(message, true)), {
            _tag: "AMQPSettlementError",
            kind: "AutoAcknowledged"
          })
        }
        yield* channel.close
        expect(yield* external(() => reference.get(target.queue))).toBe(false)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "native Direct Reply-To exchanges correlated requests with an independent amqplib responder across recovery",
    () =>
      Effect.gen(function*() {
        const reference = yield* peer
        const target = yield* queue(reference)
        const requests = yield* Queue.unbounded<Reference.ConsumeMessage>()
        yield* external(() =>
          reference.consume(target.queue, (message) => {
            if (message !== null) Queue.offerUnsafe(requests, message)
          }, { noAck: true })
        )
        const connection = yield* AMQPNodeConnection.make(broker)
        const channel = yield* connection.createChannel({ confirm: true })
        const replies = yield* channel.consume("amq.rabbitmq.reply-to", { noAck: true, maxBufferedMessages: 8 })
        const inbox = yield* Queue.unbounded<string>()
        const receiving = yield* replies.pipe(
          Stream.runForEach((message) =>
            Queue.offer(inbox, `${message.properties.correlationId}:${new TextDecoder().decode(message.content)}`)
          ),
          Effect.forkChild
        )
        for (const correlationId of ["before-recovery", "after-recovery"]) {
          if (correlationId === "after-recovery") yield* connection.reconnect
          yield* channel.sendToQueue(target.queue, encode("request"), {
            replyTo: "amq.rabbitmq.reply-to",
            correlationId
          })
          const request = yield* Queue.take(requests)
          expect(request.properties.replyTo).toMatch(/^amq\.rabbitmq\.reply-to\./)
          expect(request.properties.correlationId).toBe(correlationId)
          yield* Effect.try({
            try: () =>
              reference.sendToQueue(request.properties.replyTo, Buffer.from("response"), {
                correlationId: request.properties.correlationId
              }),
            catch: (cause) => new AMQPConnectionError({ reason: "Pinned Direct Reply-To response failed", cause })
          })
          expect(yield* Queue.take(inbox)).toBe(`${correlationId}:response`)
        }
        yield* Fiber.interrupt(receiving)
      }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
    20000
  )

  it.live(
    "unlimited prefetch resets finite credit without changing independent local buffering bounds",
    () =>
      Effect.gen(function*() {
        const reference = yield* peer
        const target = yield* queue(reference)
        const connection = yield* AMQPNodeConnection.make(broker)
        const channel = yield* connection.createChannel({ confirm: true, prefetch: 1 })
        yield* channel.prefetch(0)
        for (const body of ["one", "two", "three"]) yield* channel.sendToQueue(target.queue, encode(body))
        const messages = yield* channel.consume(target.queue, { maxBufferedMessages: 4 })
        const delivered = yield* messages.pipe(Stream.take(3), Stream.runCollect)
        expect(delivered).toHaveLength(3)
        for (const message of delivered) yield* channel.ack(message)
        yield* channel.prefetch(1)
        yield* connection.reconnect
        expect(yield* channel.get(target.queue)).toEqual(Option.none())
        expect((yield* external(() => reference.checkQueue(target.queue))).messageCount).toBe(0)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    15000
  )

  it.live("queue expiration is enforced by the broker, not by client-side deletion", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(broker)
      const channel = yield* connection.createChannel({ confirm: true })
      const name = `effect-expiration-${randomUUID()}`
      const options = { durable: true, expires: 1000, arguments: { "x-expires": 30000 } }
      yield* channel.assertQueue(name, options)
      // A passive AMQP declaration renews the queue's expiry lease. Management reads do not.
      const managementPort = Number(process.env["AMQP_TEST_MANAGEMENT_PORT"] ?? broker.port + 10000)
      const status = external(() =>
        fetch(
          `http://${broker.hostname}:${managementPort}/api/queues/%2f/${encodeURIComponent(name)}`,
          {
            headers: {
              authorization: `Basic ${Buffer.from(`${broker.username}:${broker.password}`).toString("base64")}`
            }
          }
        )
      ).pipe(Effect.map((response) => response.status))
      expect(yield* status).toBe(200)
      const deleted = yield* status.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (code) => code !== 200
        }),
        Effect.timeout("8 seconds")
      )
      expect(deleted).toBe(404)
      yield* channel.assertQueue(name, { durable: true, expires: 1000 })
      yield* channel.deleteQueue(name)
    }).pipe(Effect.scoped), 15000)
})
