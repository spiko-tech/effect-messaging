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

    it.effect(
      "Should cancel individual consumer without affecting others on shared channel",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          // Track which messages each subscriber receives
          const messagesA: Array<string> = []
          const messagesB: Array<string> = []

          const handlerA = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            messagesA.push(message.content.toString())
            return AMQPSubscriberResponse.ack()
          })

          const handlerB = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            messagesB.push(message.content.toString())
            return AMQPSubscriberResponse.ack()
          })

          // Both subscribers share a SINGLE AMQPChannel (no individual AMQPChannel.layer() wrapping).
          // Subscriber A is forked into its own fiber so it can be interrupted independently.
          const sharedChannelProgram = Effect.gen(function*() {
            const subscriberA = yield* AMQPSubscriber.make(TEST_QUEUE, { concurrency: 1 })
            const subscriberB = yield* AMQPSubscriber.make(TEST_QUEUE, { concurrency: 1 })

            // Fork subscriber A so we can interrupt it independently
            const fiberA = yield* Effect.fork(subscriberA.subscribe(handlerA))

            // Fork subscriber B — it should keep running after A is interrupted
            yield* Effect.fork(subscriberB.subscribe(handlerB))

            // Wait for both consumers to be registered with the broker
            yield* Effect.sleep("200 millis")

            // Publish a message and verify at least one subscriber processes it
            yield* publisher.publish({
              exchange: TEST_EXCHANGE,
              routingKey: TEST_SUBJECT,
              content: Buffer.from("Message 1")
            })
            yield* Effect.sleep("200 millis")
            expect(messagesA.length + messagesB.length).toBe(1)

            // Interrupt subscriber A — its consumer should be cancelled on the broker,
            // but the shared channel (and subscriber B) should remain alive.
            yield* fiberA.interruptAsFork(fiberA.id())
            yield* Effect.sleep("200 millis")

            // Publish 4 messages after interrupting A.
            // Without addFinalizer: A's consumer tag is still registered on the broker,
            // AMQP round-robins messages to it, they are delivered but never acked (dead consumer),
            // so subscriber B only receives ~half the messages.
            // With addFinalizer: A's consumer is properly cancelled, all messages go to B.
            for (let i = 2; i <= 5; i++) {
              yield* publisher.publish({
                exchange: TEST_EXCHANGE,
                routingKey: TEST_SUBJECT,
                content: Buffer.from(`Message ${i}`)
              })
            }

            yield* Effect.sleep("500 millis")

            // Subscriber A should NOT have received any of the 4 new messages
            // (it may have received Message 1 from round-robin, but nothing after interrupt)
            const totalBeforeInterrupt = messagesA.length + messagesB.length - 4
            expect(totalBeforeInterrupt).toBeLessThanOrEqual(1)

            // All 4 new messages should have been received by B
            // (total across both should be 5: 1 before interrupt + 4 after)
            expect(messagesA.length + messagesB.length).toBe(5)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          yield* sharedChannelProgram
        }).pipe(Effect.provide(testChannel), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect(
      "Should let in-flight handler finish even when handlerTimeout is configured and fiber is interrupted",
      () =>
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* AMQPPublisher.make()

          const onHandlingStarted = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()
          const onHandlingFinished = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            onHandlingStarted(message)
            // Long running task - shorter than the handlerTimeout so the timeout won't fire
            yield* Effect.sleep("600 millis")
            onHandlingFinished(message)
            return AMQPSubscriberResponse.ack()
          })

          const startSubscription = Effect.gen(function*() {
            // handlerTimeout is long enough that it won't fire — the only interrupt source is the fiber interrupt
            const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE, { handlerTimeout: "2000 millis" })
            yield* subscriber.subscribe(handler)
          }).pipe(Effect.provide(AMQPChannel.layer()))

          const subscriptionFiber = yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            exchange: TEST_EXCHANGE,
            routingKey: TEST_SUBJECT,
            content: Buffer.from("Message A")
          })

          yield* Effect.sleep("100 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)

          // Interrupt the fiber (simulating SIGINT / graceful shutdown)
          yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())

          // Wait long enough for the handler to finish if it were allowed to (600ms total, 100ms already elapsed)
          yield* Effect.sleep("700 millis")

          // The in-flight handler should have completed despite the interrupt
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
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
