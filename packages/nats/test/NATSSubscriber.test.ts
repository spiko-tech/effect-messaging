import type { Mock } from "@effect/vitest"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, TestServices } from "effect"
import type * as NATSMessage from "../src/NATSMessage.js"
import * as NATSPublisher from "../src/NATSPublisher.js"
import * as NATSSubscriber from "../src/NATSSubscriber.js"
import { testConnection } from "./dependencies.js"

// Use unique subject for this test file to avoid conflicts
const TEST_SUBJECT = "nats.subscriber.test.subject"

const publishAndAssertConsume = (
  { content, onMessage, publisher, times }: {
    publisher: NATSPublisher.NATSPublisher
    onMessage: Mock<(message: NATSMessage.NATSMessage) => void>
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

describe("NATSSubscriber", { sequential: true }, () => {
  describe("subscribe", () => {
    it.effect("Should consume published events", () =>
      Effect.gen(function*() {
        const publisher = yield* NATSPublisher.make()

        // IMPORTANT: For NATS Core, subscriber MUST be started BEFORE publishing
        // because there is no persistence - messages are fire-and-forget
        const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT)

        const onMessage = vi.fn<(message: NATSMessage.NATSMessage) => void>()

        // Start the subscription
        yield* Effect.fork(subscriber.subscribe(Effect.gen(function*() {
          const message = yield* NATSSubscriber.NATSConsumeMessage
          onMessage(message)
        })))

        // Give the subscription time to start
        yield* Effect.sleep("100 millis")

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
      }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive))

    it.effect("Should NOT receive messages published before subscription started (no persistence)", () =>
      Effect.gen(function*() {
        const publisher = yield* NATSPublisher.make()

        const onMessage = vi.fn<(message: NATSMessage.NATSMessage) => void>()

        // Publish BEFORE subscribing - this message will be lost
        yield* publisher.publish({
          subject: TEST_SUBJECT,
          payload: new TextEncoder().encode("Message published before subscription")
        })

        // Wait a bit to ensure the message is sent
        yield* Effect.sleep("100 millis")

        // Now start the subscriber
        const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT)

        yield* Effect.fork(subscriber.subscribe(Effect.gen(function*() {
          const message = yield* NATSSubscriber.NATSConsumeMessage
          onMessage(message)
        })))

        // Give the subscription time to start
        yield* Effect.sleep("100 millis")

        // The message published before subscription should NOT be received
        expect(onMessage).toHaveBeenCalledTimes(0)

        // Now publish a message AFTER subscription - this should be received
        yield* publisher.publish({
          subject: TEST_SUBJECT,
          payload: new TextEncoder().encode("Message published after subscription")
        })

        yield* Effect.sleep("200 millis")

        // Only the second message should be received
        expect(onMessage).toHaveBeenCalledTimes(1)
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
          subject: TEST_SUBJECT
        }))
      }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive))
  })

  describe("interruptable subscribers", { sequential: true }, () => {
    it.effect(
      "Should interrupt the handler if the subscription fiber is interrupted",
      () =>
        Effect.gen(function*() {
          const publisher = yield* NATSPublisher.make()

          const onHandlingStarted = vi.fn<(message: NATSMessage.NATSMessage) => void>()
          const onHandlingFinished = vi.fn<(message: NATSMessage.NATSMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* NATSSubscriber.NATSConsumeMessage
            onHandlingStarted(message)
            yield* Effect.sleep("500 millis")
            onHandlingFinished(message)
          })

          const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT)

          // Start the subscription
          const subscriptionFiber = yield* Effect.fork(subscriber.subscribe(handler))

          // Give the subscription time to start
          yield* Effect.sleep("100 millis")

          yield* publisher.publish({
            subject: TEST_SUBJECT,
            payload: new TextEncoder().encode("My Message that will be interrupted")
          })

          // Wait for the message handling to start
          yield* Effect.sleep("200 millis")
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Interrupt the subscription fiber
          yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())

          // Wait for the interruption to take effect
          yield* Effect.sleep("100 millis")

          // The message handling should be interrupted (not finished)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
        }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive),
      { timeout: 15000 }
    )

    it.effect("Should not interrupt the handler if the subscriber is uninterruptible", () =>
      Effect.gen(function*() {
        const publisher = yield* NATSPublisher.make()

        const onHandlingStarted = vi.fn<(message: NATSMessage.NATSMessage) => void>()
        const onHandlingFinished = vi.fn<(message: NATSMessage.NATSMessage) => void>()

        const handler = Effect.gen(function*() {
          const message = yield* NATSSubscriber.NATSConsumeMessage
          onHandlingStarted(message)
          yield* Effect.sleep("300 millis")
          onHandlingFinished(message)
        })

        const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT, undefined, { uninterruptible: true })

        // Start the subscription
        const subscriptionFiber = yield* Effect.fork(subscriber.subscribe(handler))

        // Give the subscription time to start
        yield* Effect.sleep("100 millis")

        yield* publisher.publish({
          subject: TEST_SUBJECT,
          payload: new TextEncoder().encode("My Message that will NOT be interrupted")
        })

        // Wait for the message to be consumed
        yield* Effect.sleep("200 millis")
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)

        // Interrupt the subscription fiber
        yield* subscriptionFiber.interruptAsFork(subscriptionFiber.id())

        // The subscription should be uninterrupted - wait for the message to be consumed
        yield* Effect.sleep("300 millis")
        expect(onHandlingFinished).toHaveBeenCalledTimes(1)
      }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive), { timeout: 15000 })

    it.effect(
      "Should timeout the handler when handlerTimeout is set",
      () =>
        Effect.gen(function*() {
          const publisher = yield* NATSPublisher.make()

          const onHandlingStarted = vi.fn<(message: NATSMessage.NATSMessage) => void>()
          const onHandlingFinished = vi.fn<(message: NATSMessage.NATSMessage) => void>()

          const handler = Effect.gen(function*() {
            const message = yield* NATSSubscriber.NATSConsumeMessage
            onHandlingStarted(message)
            // This will timeout since handlerTimeout is 200ms
            yield* Effect.sleep("500 millis")
            onHandlingFinished(message)
          })

          const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT, undefined, {
            handlerTimeout: "200 millis"
          })

          // Start the subscription
          yield* Effect.fork(subscriber.subscribe(handler))

          // Give the subscription time to start
          yield* Effect.sleep("100 millis")

          yield* publisher.publish({
            subject: TEST_SUBJECT,
            payload: new TextEncoder().encode("My Message that will timeout")
          })

          // Wait for the timeout
          yield* Effect.sleep("500 millis")

          // Handler started but did not finish due to timeout
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
        }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive),
      { timeout: 15000 }
    )
  })

  describe("error handling", () => {
    it.effect("Should continue processing messages when handler fails", () =>
      Effect.gen(function*() {
        const publisher = yield* NATSPublisher.make()

        const onHandlingStarted = vi.fn<(message: NATSMessage.NATSMessage) => void>()
        const onHandlingFinished = vi.fn<(message: NATSMessage.NATSMessage) => void>()
        let messageCount = 0

        const handler = Effect.gen(function*() {
          const message = yield* NATSSubscriber.NATSConsumeMessage
          messageCount++
          onHandlingStarted(message)

          if (messageCount === 1) {
            // Fail on first message
            return yield* Effect.fail(new Error("Simulated handler error"))
          }

          onHandlingFinished(message)
        })

        const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT)

        // Start the subscription
        yield* Effect.fork(subscriber.subscribe(handler))

        // Give the subscription time to start
        yield* Effect.sleep("100 millis")

        // First message - will fail
        yield* publisher.publish({
          subject: TEST_SUBJECT,
          payload: new TextEncoder().encode("Message that will fail")
        })

        yield* Effect.sleep("200 millis")
        expect(onHandlingStarted).toHaveBeenCalledTimes(1)
        expect(onHandlingFinished).toHaveBeenCalledTimes(0)

        // Second message - should succeed
        yield* publisher.publish({
          subject: TEST_SUBJECT,
          payload: new TextEncoder().encode("Message that will succeed")
        })

        yield* Effect.sleep("200 millis")
        expect(onHandlingStarted).toHaveBeenCalledTimes(2)
        expect(onHandlingFinished).toHaveBeenCalledTimes(1)
      }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive), { timeout: 15000 })
  })

  describe("healthCheck", () => {
    it.effect("Should succeed when subscription is healthy", () =>
      Effect.gen(function*() {
        const subscriber = yield* NATSSubscriber.make(TEST_SUBJECT)

        // Health check should succeed
        yield* subscriber.healthCheck
      }).pipe(Effect.scoped, Effect.provide(testConnection), TestServices.provideLive))
  })
})
