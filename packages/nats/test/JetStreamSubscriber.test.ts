import type { Mock } from "@effect/vitest"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Schedule, TestServices } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import type * as JetStreamMessage from "../src/JetStreamMessage.js"
import * as JetStreamPublisher from "../src/JetStreamPublisher.js"
import * as JetStreamSubscriber from "../src/JetStreamSubscriber.js"
import * as JetStreamSubscriberResponse from "../src/JetStreamSubscriberResponse.js"
import { makeTestConsumer, makeTestStream, purgeTestStream, testJetStream } from "./dependencies.js"

// Use unique names for this test file to avoid conflicts with other test files
const TEST_STREAM = "SUBSCRIBER_TEST_STREAM"
const TEST_CONSUMER = "SUBSCRIBER_TEST_CONSUMER"
const TEST_SUBJECT = "subscriber.test.subject"

const publishAndAssertConsume = (
  { content, onMessage, publisher, times }: {
    publisher: JetStreamPublisher.JetStreamPublisher
    onMessage: Mock<(message: JetStreamMessage.JetStreamMessage) => void>
    content: Uint8Array
    times: number
  }
) =>
  Effect.gen(function*() {
    yield* publisher.publish({
      subject: TEST_SUBJECT,
      payload: content
    })

    // Wait for the message to be consumed
    yield* Effect.sleep("200 millis")
    // Verify the message was consumed
    expect(onMessage).toHaveBeenCalledTimes(times)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      subject: TEST_SUBJECT
    }))
  })

const setup = Effect.gen(function*() {
  // Create the test stream and consumer
  yield* makeTestStream(TEST_STREAM, [TEST_SUBJECT])
  yield* makeTestConsumer(TEST_STREAM, TEST_CONSUMER)
  // Purge the test stream
  yield* purgeTestStream(TEST_STREAM)
})

describe("JetStreamSubscriber", { sequential: true }, () => {
  describe("subscribe", () => {
    it.effect("Should consume published events", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* JetStreamPublisher.make({
            retrySchedule: Schedule.exponential("100 millis", 1.5).pipe(
              Schedule.jittered,
              Schedule.intersect(Schedule.recurs(10))
            )
          })

          const client = yield* JetStreamClient.JetStreamClient
          const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
          const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)

          const onMessage = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()

          // Start the subscription
          yield* Effect.fork(subscriber.subscribe(Effect.gen(function*() {
            const message = yield* JetStreamSubscriber.JetStreamConsumeMessage
            onMessage(message)
            return JetStreamSubscriberResponse.ack()
          })))

          // Message 1
          yield* publishAndAssertConsume({
            publisher,
            onMessage,
            content: new TextEncoder().encode("Message 1"),
            times: 1
          })

          // Message 2
          yield* publishAndAssertConsume({
            publisher,
            onMessage,
            content: new TextEncoder().encode("Message 2"),
            times: 2
          })

          // Message 3
          yield* publishAndAssertConsume({
            publisher,
            onMessage,
            content: new TextEncoder().encode("Message 3"),
            times: 3
          })
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))
  })

  describe("interruptable subscribers", { sequential: true }, () => {
    it.effect(
      "Should interrupt the handler if the subscription fiber is interrupted, and the message should be consumed again",
      () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* setup

            const publisher = yield* JetStreamPublisher.make()

            const onHandlingStarted = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
            const onHandlingFinished = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()

            const handler = Effect.gen(function*() {
              const message = yield* JetStreamSubscriber.JetStreamConsumeMessage
              onHandlingStarted(message)
              yield* Effect.sleep("500 millis")
              onHandlingFinished(message)
              return JetStreamSubscriberResponse.ack()
            })

            const client = yield* JetStreamClient.JetStreamClient

            const startSubscription = Effect.gen(function*() {
              const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
              const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
              yield* subscriber.subscribe(handler)
            })

            // Start the subscription
            const subscriptionFiber1 = yield* Effect.fork(startSubscription)

            yield* publisher.publish({
              subject: TEST_SUBJECT,
              payload: new TextEncoder().encode("My Message that will be interrupted")
            })

            // Wait for the message to be consumed
            yield* Effect.sleep("300 millis")
            // Verify the message was consumed at least once
            expect(onHandlingStarted.mock.calls.length).toBeGreaterThanOrEqual(1)
            const startedCountBeforeInterrupt = onHandlingStarted.mock.calls.length

            yield* subscriptionFiber1.interruptAsFork(subscriptionFiber1.id())

            // Wait for the interruption to complete
            yield* Effect.sleep("300 millis")

            // The message handling should be interrupted (not finished yet for the first delivery)
            expect(onHandlingFinished.mock.calls.length).toBeLessThan(startedCountBeforeInterrupt)

            // Start the subscription again
            yield* Effect.fork(startSubscription)

            // Wait for ack_wait to expire (500ms) + handler execution time + buffer
            yield* Effect.sleep("1.5 seconds")
            // The message should eventually be processed successfully
            expect(onHandlingFinished.mock.calls.length).toBeGreaterThanOrEqual(1)
          })
        ).pipe(Effect.provide(testJetStream), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect("Should not interrupt the handler if the subscriber is uninterruptible", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* JetStreamPublisher.make()

          const onHandlingStarted = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
          const onHandlingFinished = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* JetStreamSubscriber.JetStreamConsumeMessage
            onHandlingStarted(message)
            yield* Effect.sleep("300 millis")
            onHandlingFinished(message)
            return JetStreamSubscriberResponse.ack()
          })

          const client = yield* JetStreamClient.JetStreamClient

          const startSubscription = Effect.gen(function*() {
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
            const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer, { uninterruptible: true })
            yield* subscriber.subscribe(handler)
          })

          // Start the subscription
          const subscriptionFiber1 = yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            subject: TEST_SUBJECT,
            payload: new TextEncoder().encode("My Message that will NOT be interrupted")
          })

          // Wait for the message to be consumed
          yield* Effect.sleep("200 millis")
          // Verify the message was consumed
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Interrupt the subscription fiber
          yield* subscriptionFiber1.interruptAsFork(subscriptionFiber1.id())

          // The subscription should be uninterrupted - wait for the message to be consumed
          yield* Effect.sleep("300 millis")
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)

          // Start the subscription again
          yield* Effect.fork(startSubscription)

          yield* Effect.sleep("500 millis")
          // The same message should not be consumed again because the first subscription was uninterrupted and the message was acked
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive), { timeout: 15000 })

    it.effect(
      "Should timeout the handler when handlerTimeout is set, and message should be nacked for redelivery",
      () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* setup

            const publisher = yield* JetStreamPublisher.make()

            const onHandlingStarted = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
            const onHandlingFinished = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
            let attemptCount = 0

            const handler = Effect.gen(function*() {
              const message = yield* JetStreamSubscriber.JetStreamConsumeMessage
              attemptCount++
              onHandlingStarted(message)

              if (attemptCount === 1) {
                // First attempt: long running task that will timeout
                yield* Effect.sleep("2 seconds")
              } else {
                // Subsequent attempts: complete quickly
                yield* Effect.sleep("50 millis")
              }
              onHandlingFinished(message)
              return JetStreamSubscriberResponse.ack()
            })

            const client = yield* JetStreamClient.JetStreamClient

            const startSubscription = Effect.gen(function*() {
              const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
              const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer, {
                handlerTimeout: "300 millis"
              })
              yield* subscriber.subscribe(handler)
            })

            // Start the subscription
            yield* Effect.fork(startSubscription)

            yield* publisher.publish({
              subject: TEST_SUBJECT,
              payload: new TextEncoder().encode("My Message that will timeout on first attempt")
            })

            // Wait for first attempt to start and timeout
            yield* Effect.sleep("200 millis")
            expect(onHandlingStarted).toHaveBeenCalledTimes(1)

            // Wait for timeout to trigger (300ms) + nack + redelivery
            yield* Effect.sleep("1 second")

            // First attempt should have timed out (not finished), but subsequent attempts should complete
            // The message should have been redelivered after the timeout
            expect(onHandlingStarted.mock.calls.length).toBeGreaterThanOrEqual(2)
            expect(onHandlingFinished.mock.calls.length).toBeGreaterThanOrEqual(1)
          })
        ).pipe(Effect.provide(testJetStream), TestServices.provideLive),
      { timeout: 30000 }
    )
  })

  describe("error handling", () => {
    it.effect("Should nak the message when handler fails", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* setup

          const publisher = yield* JetStreamPublisher.make()

          const onHandlingStarted = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
          const onHandlingFinished = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()
          let errorCount = 0

          const handler = Effect.gen(function*() {
            const message = yield* JetStreamSubscriber.JetStreamConsumeMessage
            onHandlingStarted(message)

            errorCount++
            if (errorCount === 1) {
              // Fail on first attempt
              return yield* Effect.fail(new Error("Simulated handler error"))
            }

            onHandlingFinished(message)
            return JetStreamSubscriberResponse.ack()
          })

          const client = yield* JetStreamClient.JetStreamClient

          const startSubscription = Effect.gen(function*() {
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
            const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)
            yield* subscriber.subscribe(handler)
          })

          // Start the subscription
          yield* Effect.fork(startSubscription)

          yield* publisher.publish({
            subject: TEST_SUBJECT,
            payload: new TextEncoder().encode("Message that will fail first time")
          })

          // Wait for message to be processed and redelivered
          yield* Effect.sleep("1 second")

          // The message should be processed twice: once failing, once succeeding
          expect(onHandlingStarted).toHaveBeenCalledTimes(2)
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive), { timeout: 15000 })
  })

  describe("healthCheck", () => {
    it.effect("Should succeed when consumer is healthy", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* setup

          const client = yield* JetStreamClient.JetStreamClient
          const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
          const subscriber = yield* JetStreamSubscriber.fromConsumer(consumer)

          // Health check should succeed
          yield* subscriber.healthCheck
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))
  })
})
