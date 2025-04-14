import type { Mock } from "@effect/vitest"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Schedule, TestServices } from "effect"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.js"
import * as AMQPPublisher from "../src/AMQPPublisher.js"
import * as AMQPSubscriber from "../src/AMQPSubscriber.js"
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

const makeHandler = (
  fn: (message: AMQPConsumeMessage.AMQPConsumeMessage) => void
) =>
  Effect.gen(function*() {
    const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
    fn(message)
  })

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
    yield* Effect.sleep("50 millis")
    // Verify the message was consumed
    expect(onMessage).toHaveBeenCalledTimes(times)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      fields: expect.objectContaining({ routingKey: TEST_SUBJECT }),
      content
    }))
  })

describe("AMQPChannel", () => {
  describe("subscribe", () => {
    it.effect("Should consume published events", () =>
      Effect.gen(function*() {
        // Create the test exchange, queue and binding
        yield* assertTestExchange
        yield* assertTestQueue
        yield* bindTestQueue
        // Purge the test queue
        yield* purgeTestQueue

        const publisher = yield* AMQPPublisher.make({
          retrySchedule: Schedule.exponential("100 millis", 1.5).pipe(
            Schedule.jittered,
            Schedule.intersect(Schedule.recurs(10))
          )
        })
        const subscriber = yield* AMQPSubscriber.make(TEST_QUEUE)

        const onMessage = vi.fn<(message: AMQPConsumeMessage.AMQPConsumeMessage) => void>()

        // Start the subscription
        yield* Effect.fork(subscriber.subscribe(makeHandler(onMessage)))

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
})
