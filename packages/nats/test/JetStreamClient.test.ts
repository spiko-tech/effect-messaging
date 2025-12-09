import { describe, expect, layer } from "@effect/vitest"
import { Chunk, Effect, Option, Stream, TestServices } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import {
  makeTestStreamAndConsumer,
  TEST_CONSUMER,
  TEST_STREAM,
  TEST_SUBJECT,
  testJetStream,
  testJetStreamClient
} from "./dependencies.js"

describe("JetStreamClient", { sequential: true }, () => {
  describe("basic operations", () => {
    layer(testJetStreamClient)((it) => {
      it.effect("Should be able to create a JetStream client", () =>
        Effect.gen(function*() {
          const jetStreamclient = yield* JetStreamClient.JetStreamClient
          expect(jetStreamclient.apiPrefix).toEqual(expect.any(String))
        }))
    })
  })

  describe("publish and consume", () => {
    layer(testJetStream)((it) => {
      it("Should publish and fetch messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient

            // Publish messages first
            yield* client.publish(TEST_SUBJECT, "Fetch Message 1")
            yield* client.publish(TEST_SUBJECT, "Fetch Message 2")
            yield* client.publish(TEST_SUBJECT, "Fetch Message 3")

            // Small delay to ensure messages are stored
            yield* Effect.sleep("100 millis")

            // Fetch messages
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
            const fetched = yield* consumer.fetch({ max_messages: 3, expires: 5000 })
            const messages = yield* fetched.stream.pipe(
              Stream.take(3),
              Stream.runCollect
            )
            const messagesArray = Chunk.toArray(messages)

            expect(messagesArray.length).toBe(3)
            expect(messagesArray[0].string()).toBe("Fetch Message 1")
            expect(messagesArray[1].string()).toBe("Fetch Message 2")
            expect(messagesArray[2].string()).toBe("Fetch Message 3")

            yield* Effect.all(messagesArray.map((msg) => msg.ack))
          })
        ).pipe(TestServices.provideLive))

      it("Should handle JSON messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            interface TestPayload {
              id: number
              name: string
            }

            const payload: TestPayload = {
              id: 123,
              name: "test-payload"
            }

            yield* client.publish(TEST_SUBJECT, JSON.stringify(payload))
            yield* Effect.sleep("100 millis")

            const fetched = yield* consumer.fetch({ max_messages: 1, expires: 5000 })
            const messages = yield* fetched.stream.pipe(
              Stream.take(1),
              Stream.runCollect
            )
            const messagesArray = Chunk.toArray(messages)

            expect(messagesArray.length).toBe(1)

            const receivedPayload = yield* messagesArray[0].json<TestPayload>()
            expect(receivedPayload).toEqual(payload)

            yield* messagesArray[0].ack
          })
        ).pipe(TestServices.provideLive))

      it("Should handle message redelivery with nak", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            yield* client.publish(TEST_SUBJECT, "Redelivery Test")
            yield* Effect.sleep("100 millis")

            // First fetch - nak the message
            const fetched1 = yield* consumer.fetch({ max_messages: 1, expires: 5000 })
            const messages1 = yield* fetched1.stream.pipe(
              Stream.take(1),
              Stream.runCollect
            )
            const messagesArray1 = Chunk.toArray(messages1)

            expect(messagesArray1.length).toBe(1)
            expect(messagesArray1[0].redelivered).toBe(false)

            yield* messagesArray1[0].nak()
            yield* Effect.sleep("100 millis")

            // Second fetch - should get the same message redelivered
            const fetched2 = yield* consumer.fetch({ max_messages: 1, expires: 5000 })
            const messages2 = yield* fetched2.stream.pipe(
              Stream.take(1),
              Stream.runCollect
            )
            const messagesArray2 = Chunk.toArray(messages2)

            expect(messagesArray2.length).toBe(1)
            expect(messagesArray2[0].redelivered).toBe(true)
            expect(messagesArray2[0].string()).toBe("Redelivery Test")

            yield* messagesArray2[0].ack
          })
        ).pipe(TestServices.provideLive))

      it("Should use next to get single messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            yield* client.publish(TEST_SUBJECT, "Next Message 1")
            yield* client.publish(TEST_SUBJECT, "Next Message 2")

            yield* Effect.sleep("100 millis")

            const msg1Option = yield* consumer.next({ expires: 5000 })
            expect(Option.isSome(msg1Option)).toBe(true)

            if (Option.isSome(msg1Option)) {
              const msg1 = msg1Option.value
              expect(msg1.string()).toBe("Next Message 1")
              yield* msg1.ack
            }

            const msg2Option = yield* consumer.next({ expires: 5000 })
            expect(Option.isSome(msg2Option)).toBe(true)

            if (Option.isSome(msg2Option)) {
              const msg2 = msg2Option.value
              expect(msg2.string()).toBe("Next Message 2")
              yield* msg2.ack
            }
          })
        ).pipe(TestServices.provideLive))

      it("Should consume messages continuously with consume", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            // Publish messages
            yield* client.publish(TEST_SUBJECT, "Consume Message 1")
            yield* client.publish(TEST_SUBJECT, "Consume Message 2")
            yield* client.publish(TEST_SUBJECT, "Consume Message 3")

            yield* Effect.sleep("100 millis")

            // Start consuming - this returns an iterator that continuously receives messages
            const consumerMessages = yield* consumer.consume()

            // Collect messages from the stream
            const messages = yield* consumerMessages.stream.pipe(
              Stream.take(3),
              Stream.runCollect
            )
            const messagesArray = Chunk.toArray(messages)

            expect(messagesArray.length).toBe(3)
            expect(messagesArray[0].string()).toBe("Consume Message 1")
            expect(messagesArray[1].string()).toBe("Consume Message 2")
            expect(messagesArray[2].string()).toBe("Consume Message 3")

            // Acknowledge all messages
            yield* Effect.all(messagesArray.map((msg) => msg.ack))

            // Close the consumer messages iterator
            yield* consumerMessages.close
          })
        ).pipe(TestServices.provideLive))
    })
  })
})
