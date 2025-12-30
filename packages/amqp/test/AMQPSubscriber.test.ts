import type { Mock } from "@effect/vitest"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Schedule, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.js"
import * as AMQPPublisher from "../src/AMQPPublisher.js"
import * as AMQPSubscriber from "../src/AMQPSubscriber.js"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.js"
import {
  assertTestExchange,
  assertTestQueue,
  bindTestQueue,
  purgeTestQueue,
  simulateChannelClose,
  simulateConnectionClose,
  TEST_EXCHANGE,
  TEST_QUEUE,
  TEST_SUBJECT,
  testChannel
} from "./dependencies.js"

const publishAndAssertConsume = (
  { content, onMessage, publisher, times }: {
    publisher: AMQPPublisher.AMQPPublisher
    onMessage: Mock<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>
    content: Buffer
    times: number
  }
) =>
  Effect.gen(function*() {
    yield* publisher.publish({
      exchange: TEST_EXCHANGE,
      routingKey: TEST_SUBJECT,
      content
    })

    // Wait for the message to be consumed
    yield* Effect.sleep("200 millis")
    // Verify the message was consumed
    expect(onMessage).toHaveBeenCalledTimes(times)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      fields: expect.objectContaining({ routingKey: TEST_SUBJECT }),
      content
    }))
  })

const setup = Effect.gen(function*() {
  // Create the test exchange, queue and binding
  yield* assertTestExchange
  yield* assertTestQueue
  yield* bindTestQueue
  // Purge the test queue
  yield* purgeTestQueue
})

describe("AMQPChannel", { sequential: true }, () => {
  describe("subscribe", () => {
    it.effect("Should consume published events even when connection or channel fails", () =>
      Effect.gen(function*() {
        yield* setup

        const publisher = yield* AMQPPublisher.make({
          retrySchedule: Schedule.exponential("100 millis", 1.5).pipe(
            Schedule.jittered,
            Schedule.intersect(Schedule.recurs(10))
          )
        })
        const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)

        const onMessage = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

        // Start the subscription
        yield* Effect.fork(subscriber.subscribe(Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          onMessage(message)
          return AMQPSubscriberResponse.ack()
        })))

        // Message 1
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 1"),
          times: 1
        })

        // Message 2
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 2"),
          times: 2
        })

        // simulate connection failure
        yield* simulateConnectionClose

        // Message 3
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 3"),
          times: 3
        })

        // Message 4
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 4"),
          times: 4
        })

        // simulate channel failure
        yield* simulateChannelClose

        // Message 5
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 5"),
          times: 5
        })

        // Message 6
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 6"),
          times: 6
        })

        // simulate connection failure again
        yield* simulateConnectionClose

        // Message 7
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 7"),
          times: 7
        })

        // Message 8
        yield* publishAndAssertConsume({
          publisher,
          onMessage,
          content: Buffer.from("Message 8"),
          times: 8
        })
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })

  describe("interruptable subscribers", { sequential: true }, () => {
    it.effect(
      "Should interrupt the handler if the subscription fiber is interrupted, and the message should be consumed again",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            yield* Effect.sleep("500 millis")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer())) // Provide a fresh channel for each subscription

          // Start the subscription
          const subscribptionFiber1 = yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("My Message that will be interrupted")
          })

          // Wait for the message to be consumed
          yield* Effect.sleep("300 millis")
          // Verify the message was consumed
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          yield* subscribptionFiber1.interruptAsFork(subscribptionFiber1.id())

          // Wait for the interruption to complete
          yield* Effect.sleep("500 millis")

          // The message handling should be interrupted
          expect(onHandlingFinished).not.toHaveBeenCalled()

          // Start the subscription again (with a new channel)
          yield* Effect.fork(startSubscription)

          yield* Effect.sleep("700 millis")
          // The same message should be consumed again because the first subscription was interrupted and the message was nor acked nor nacked
          expect(onHandlingStarted).toHaveBeenCalledTimes(2)
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect("Should no interrupt the handler if the subscriber is uninterruptible", () =>
      Effect.gen(function*() {
        yield* setup

        const publisher = yield* AMQPPublisher.make()

        const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
        const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

        const handler = Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          onHandlingStarted(message)
          yield* Effect.sleep("300 millis")
          onHandlingFinished(message)
          return AMQPSubscriberResponse.ack()
        })

        const startSubscription = Effect.gen(function*() {
          const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE, { uninterruptible: true })
          yield* subscriber.subscribe(handler)
        }).pipe(Effect.provide(AMQPChannel.layer())) // Provide a fresh channel for each subscription

        // Start the subscription
        const subscribptionFiber1 = yield* Effect.fork(startSubscription)

        yield* publisher.publish({
          exchange: TEST_EXCHANGE,
          routingKey: TEST_SUBJECT,
          content: Buffer.from("My Message that will NOT be interrupted")
        })

        // Wait for the message to be consumed
        yield* Effect.sleep("200 millis")
        // Verify the message was consumed
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)

        // Interrupt the subscription fiber
        yield* subscribptionFiber1.interruptAsFork(subscribptionFiber1.id())

        // The subscription should be uninterrupted - wait for the message to be consumed
        yield* Effect.sleep("300 millis")
        expect(onHandlingFinished).toHaveBeenCalledTimes(1)

        // Start the subscription again (with a new channel)
        yield* Effect.fork(startSubscription)

        yield* Effect.sleep("500 millis")
        // The same message should not be consumed again because the first subscription was uninterrupted and the message was acked or nacked
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)
        expect(onHandlingFinished).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(testChannel), TestServices.provideLive), { timeout: 15000 })

    it.effect(
      "Should interrupt the handler if the subscriber is uninterruptible but reaches the timeout",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            // long running task
            yield* Effect.sleep("500 millis")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE, {
              uninterruptible: true,
              handlerTimeout: "300 millis"
            })
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer())) // Provide a fresh channel for each subscription

          // Start the subscription
          const subscribptionFiber1 = yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("My Message that will NOT be interrupted")
          })

          // Wait for the message to be consumed
          yield* Effect.sleep("200 millis")
          // Verify the message was consumed
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Interrupt the subscription fiber
          yield* subscribptionFiber1.interruptAsFork(subscribptionFiber1.id())

          // wait for the handler to timeout
          yield* Effect.sleep("300 millis")
          // The handler should timeout and should be interrupted
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)

          // Start the subscription again (with a new channel)
          yield* Effect.fork(startSubscription)

          yield* Effect.sleep("700 millis")
          // The same message should not be consumed again because the has timed out and was nacked
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 30000 }
    )
  })
})
