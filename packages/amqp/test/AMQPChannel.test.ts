import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import { AMQPChannelError } from "../src/AMQPError.js"
import {
  assertTestExchange,
  assertTestQueue,
  simulateChannelClose,
  simulateConnectionClose,
  testChannel,
  testConfirmChannel
} from "./dependencies.js"

describe("AMQPChannel", () => {
  layer(testChannel)("connection", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel

        expect(yield* channel.connection.serverProperties).toMatchObject({
          hostname: "localhost",
          port: "5679",
          product: "RabbitMQ"
        })
      }))
  })

  describe("watchChannel", () => {
    it.effect("Should reconnect the channel when close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateChannelClose

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should reconnect the channel when the connection is close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateConnectionClose

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })

  describe("checkQueue", () => {
    it.effect("Should return a successful assertion of the queue", () =>
      Effect.gen(function*() {
        yield* assertTestQueue
        const channel = yield* AMQPChannel.AMQPChannel
        const result = yield* channel.checkQueue("TEST_QUEUE")
        expect(result).toMatchObject({ queue: "TEST_QUEUE" })
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should return an error when the queue does not exist", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const exit = yield* channel.checkQueue("NON_EXISTENT_QUEUE").pipe(Effect.exit)
        expect(exit).toStrictEqual(Exit.fail(expect.any(AMQPChannelError)))
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })

  describe("confirm channel", () => {
    // Tests run concurrently against one broker, so each test owns its resources.
    // Queues are bound with their own name as routing key.
    const resources = (name: string) => ({
      exchange: `TEST_CONFIRM_${name}_EXCHANGE`,
      queue: `TEST_CONFIRM_${name}_QUEUE`,
      // holds one message and makes the broker nack any further publish
      rejectingQueue: `TEST_CONFIRM_${name}_REJECTING_QUEUE`
    })
    type Resources = ReturnType<typeof resources>

    const setup = (r: Resources) =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        yield* channel.assertExchange(r.exchange, "direct", { durable: true })
        yield* channel.assertQueue(r.queue, { durable: true })
        yield* channel.bindQueue(r.queue, r.exchange, r.queue)
        yield* channel.assertQueue(r.rejectingQueue, {
          durable: true,
          arguments: { "x-max-length": 1, "x-overflow": "reject-publish" }
        })
        yield* channel.bindQueue(r.rejectingQueue, r.exchange, r.rejectingQueue)
      })

    const cleanup = (r: Resources) =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        yield* channel.deleteQueue(r.queue)
        yield* channel.deleteQueue(r.rejectingQueue)
        yield* channel.deleteExchange(r.exchange)
      }).pipe(Effect.ignore)

    const withResources = <A, E>(
      name: string,
      test: (r: Resources) => Effect.Effect<A, E, AMQPChannel.AMQPChannel>
    ) => {
      const r = resources(name)
      return setup(r).pipe(
        Effect.andThen(test(r)),
        Effect.ensuring(cleanup(r)),
        Effect.provide(testConfirmChannel),
        TestServices.provideLive
      )
    }

    const getContent = (queue: string) =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const message = yield* channel.get(queue, { noAck: true })
        return message === false ? false : message.content.toString()
      })

    const expectFailure = (exit: Exit.Exit<unknown, unknown>, reason: string) =>
      expect(exit).toStrictEqual(Exit.fail(expect.objectContaining({ reason })))

    it.effect("publish succeeds once the broker has confirmed the message", () =>
      withResources("ACK", (r) =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          yield* channel.publish(r.exchange, r.queue, Buffer.from("payload"), { persistent: true })
          expect(yield* getContent(r.queue)).toBe("payload")
        })))

    it.effect("publish fails when the broker nacks the message", () =>
      withResources("NACK", (r) =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          yield* channel.publish(r.exchange, r.rejectingQueue, Buffer.from("first"))
          const exit = yield* channel.publish(r.exchange, r.rejectingQueue, Buffer.from("second")).pipe(Effect.exit)
          expectFailure(exit, "Broker nacked message")
        })))

    it.effect("sendToQueue waits for the broker confirm as well", () =>
      withResources("SEND_TO_QUEUE", (r) =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          yield* channel.sendToQueue(r.rejectingQueue, Buffer.from("first"))
          const exit = yield* channel.sendToQueue(r.rejectingQueue, Buffer.from("second")).pipe(Effect.exit)
          expectFailure(exit, "Broker nacked message")
        })))

    it.effect("publish fails when the target exchange does not exist", () =>
      withResources("NO_EXCHANGE", () =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          const exit = yield* channel.publish("NON_EXISTENT_EXCHANGE", "whatever", Buffer.from("payload")).pipe(
            Effect.exit
          )
          expectFailure(exit, "Channel closed before confirm")
        })))

    it.effect("a publish rejected before reaching the broker leaves the channel usable", () =>
      withResources("SYNC_FAILURE", (r) =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          // amqplib rejects routing keys above 255 bytes synchronously, after queuing the confirm callback
          const exit = yield* channel.publish(r.exchange, "k".repeat(256), Buffer.from("payload")).pipe(Effect.exit)
          expectFailure(exit, "Failed to publish on channel")
          // without discarding the channel, this confirm would be attributed to the rejected publish and never resolve
          yield* channel.publish(r.exchange, r.queue, Buffer.from("payload"))
          expect(yield* getContent(r.queue)).toBe("payload")
        })))

    it.effect("the channel reopened after a close is still a confirm channel", () =>
      withResources("REOPEN", (r) =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          yield* simulateChannelClose
          yield* channel.publish(r.exchange, r.rejectingQueue, Buffer.from("first"))
          const exit = yield* channel.publish(r.exchange, r.rejectingQueue, Buffer.from("second")).pipe(Effect.exit)
          expectFailure(exit, "Broker nacked message")
        })))
  })
})
