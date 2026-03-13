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

  describe("uninterruptible subscribers", { sequential: true }, () => {
    it.effect(
      "Should not interrupt the handler if the subscription fiber is interrupted",
      () =>
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
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
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
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect(
      "Should interrupt the handler if the subscriber reaches the timeout",
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
          // The same message should not be consumed again because it has timed out and was nacked
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          // The handler should not have finished because the timeout interrupted it before completion
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 30000 }
    )

    it.effect(
      "Should timeout the handler without external interruption",
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
            yield* Effect.sleep("2 seconds")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE, {
              handlerTimeout: "500 millis"
            })
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          // Start the subscription (no external interruption)
          yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("My Message that should timeout")
          })

          // Wait for the message to be consumed and started
          yield* Effect.sleep("200 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Wait for the timeout to fire (500 millis) + some margin
          yield* Effect.sleep("800 millis")

          // The handler should have been interrupted by the timeout, NOT run to completion
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )
  })

  describe("consumer cancellation on interruption", { sequential: true }, () => {
    it.effect(
      "Should cancel the AMQP consumer when the subscription fiber is interrupted, preventing new message dispatch",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const messagesReceived: Array<string> = []

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            messagesReceived.push(message.content.toString())
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          // Start the subscription
          const subscriptionFiber = yield* Effect.fork(startSubscription)

          // Publish a message and verify it's consumed
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message before interrupt")
          })
          yield* Effect.sleep("200 millis")
          expect(messagesReceived).toEqual(["Message before interrupt"])

          // Interrupt the subscription fiber (simulating SIGINT / graceful shutdown)
          yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())
          yield* Effect.sleep("200 millis")

          // Publish another message after the interrupt - it should stay in the queue
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message after interrupt")
          })
          yield* Effect.sleep("200 millis")

          // The second message should NOT have been consumed by the interrupted subscriber
          expect(messagesReceived).toEqual(["Message before interrupt"])

          // Start a new subscription to verify the message is still in the queue
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
          yield* Effect.sleep("500 millis")

          // The new subscriber should pick up the message that was published after the interrupt
          expect(messagesReceivedByNewSubscriber).toEqual(["Message after interrupt"])
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect(
      "Should cancel the consumer but let uninterruptible in-flight handler complete",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            // Long running task - 3 seconds
            yield* Effect.sleep("3 seconds")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          // Start the subscription
          const subscriptionFiber = yield* Effect.fork(startSubscription)

          // Publish message A
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message A")
          })

          // Wait for the handler to start processing
          yield* Effect.sleep("200 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)

          // After ~1s, interrupt the subscription fiber (simulating graceful shutdown).
          // The consumer should stop accepting new messages, but the in-flight handler should continue.
          yield* Effect.sleep("800 millis")
          yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())

          // Wait 1s then publish message B - it should NOT be picked up by the cancelled consumer.
          yield* Effect.sleep("1 second")
          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message B")
          })

          // Wait for the in-flight handler to finish (started at t=0.2s, 3s duration, so finishes around t=3.2s)
          yield* Effect.sleep("2 seconds")
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
          yield* Effect.sleep("500 millis")

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
        yield* Effect.sleep("1 second")

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
        yield* Effect.sleep("500 millis")

        // The message should be processed only once (reject without requeue prevents redelivery)
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)

        // Wait a bit more to ensure no redelivery happens
        yield* Effect.sleep("1 second")
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(testChannel), TestServices.provideLive), { timeout: 15000 })
  })
})
