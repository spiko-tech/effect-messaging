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
    yield* Effect.sleep("100 millis")
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

  describe("handler timeout", { sequential: true }, () => {
    it.effect(
      "Should interrupt the handler when it exceeds the timeout, nacking the message",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            // long running task that exceeds the timeout
            yield* Effect.sleep("400 millis")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE, {
              handlerTimeout: "150 millis"
            })
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          // Start the subscription
          yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("My Message that should timeout")
          })

          // Wait for the handler to start processing
          yield* Effect.sleep("100 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Wait for the timeout to fire (150 millis) + some margin
          yield* Effect.sleep("300 millis")

          // The handler should have been interrupted by the timeout, NOT run to completion
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)

          // Start a new subscription to verify the message is NOT redelivered (it was nacked without requeue)
          yield* Effect.fork(startSubscription)

          yield* Effect.sleep("300 millis")
          // The message should not be consumed again because it was nacked by the timeout
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )
  })

  describe("consumer cancellation on interruption", { sequential: true }, () => {
    it.effect(
      "Should cancel the consumer on interrupt, let in-flight handler complete, and leave new messages for the next subscriber",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            // Long running task - 600ms
            yield* Effect.sleep("600 millis")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          // Start the subscription
          const subscriptionFiber = yield* Effect.fork(startSubscription)

          // Publish message A and wait for handler to start processing
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message A")
          })

          yield* Effect.sleep("100 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)

          // Interrupt the subscription fiber (simulating graceful shutdown).
          // The consumer should stop accepting new messages, but the in-flight handler should continue.
          yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())

          // Publish message B after interrupt - it should NOT be picked up by the cancelled consumer.
          yield* Effect.sleep("200 millis")
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message B")
          })

          // Wait for the in-flight handler to finish (started at t=0.1s, 600ms duration, so finishes around t=0.7s)
          yield* Effect.sleep("500 millis")
          // The in-flight handler should have completed (uninterruptible guarantee)
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
          // Message B should NOT have been consumed - the consumer was cancelled on interrupt
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Start a new subscription to verify message B is still in the queue
          const messagesReceivedByNewSubscriber: Array<string> = []
          const newHandler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            messagesReceivedByNewSubscriber.push(message.content.toString())
            return AMQPSubscriberResponse.ack()
          })

          const newSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
            yield* subscriber.subscribe(newHandler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          yield* Effect.fork(newSubscription)
          yield* Effect.sleep("200 millis")

          // The new subscriber should pick up message B
          expect(messagesReceivedByNewSubscriber).toEqual(["Message B"])
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )
  })

  describe("explicit response types", () => {
    it.effect("Should nack the message when handler returns nack()", () =>
      Effect.gen(function*() {
        yield* setup

        const publisher = yield* AMQPPublisher.make()

        const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
        let attemptCount = 0

        const handler = Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          attemptCount++
          onHandlingStarted(message)

          if (attemptCount === 1) {
            // First attempt: nack with requeue to trigger redelivery
            return AMQPSubscriberResponse.nack({ requeue: true })
          }

          // Subsequent attempts: ack
          return AMQPSubscriberResponse.ack()
        })

        const startSubscription = Effect.gen(function*() {
          const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
          yield* subscriber.subscribe(handler)
        }).pipe(Effect.provide(AMQPChannel.layer()))

        // Start the subscription
        yield* Effect.fork(startSubscription)

        yield* publisher.publish({
          exchange: TEST_EXCHANGE,
          routingKey: TEST_SUBJECT,
          content: Buffer.from("Message that will be nacked first")
        })

        // Wait for message to be processed and redelivered
        yield* Effect.sleep("400 millis")

        // The message should be processed twice: once nacked, once acked
        expect(onHandlingStarted).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(testChannel), TestServices.provideLive), { timeout: 15000 })

    it.effect("Should reject the message without requeue when handler returns reject()", () =>
      Effect.gen(function*() {
        yield* setup

        const publisher = yield* AMQPPublisher.make()

        const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

        const handler = Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          onHandlingStarted(message)

          // Reject the message without requeue - message won't be redelivered
          return AMQPSubscriberResponse.reject({ requeue: false })
        })

        const startSubscription = Effect.gen(function*() {
          const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
          yield* subscriber.subscribe(handler)
        }).pipe(Effect.provide(AMQPChannel.layer()))

        // Start the subscription
        yield* Effect.fork(startSubscription)

        yield* publisher.publish({
          exchange: TEST_EXCHANGE,
          routingKey: TEST_SUBJECT,
          content: Buffer.from("Message that will be rejected")
        })

        // Wait for message to be processed
        yield* Effect.sleep("200 millis")

        // The message should be processed only once (reject without requeue prevents redelivery)
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)

        // Wait a bit more to ensure no redelivery happens
        yield* Effect.sleep("300 millis")
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(testChannel), TestServices.provideLive), { timeout: 15000 })
  })
})
