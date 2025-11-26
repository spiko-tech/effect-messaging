import { describe, expect, layer, vi } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import type * as JetStreamMessage from "../src/JetStreamMessage.js"
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
      it.effect("Should publish and consume messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            const onMessage = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()

            const consumerMessages = yield* consumer.consume()
            yield* Effect.fork(
              Stream.runForEach(consumerMessages.stream, (message) =>
                Effect.gen(function*() {
                  onMessage(message)
                  yield* message.ack
                }))
            )

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 1"))
            yield* Effect.sleep("100 millis")
            expect(onMessage).toHaveBeenCalledTimes(1)

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 2"))
            yield* Effect.sleep("100 millis")
            expect(onMessage).toHaveBeenCalledTimes(2)

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 3"))
            yield* Effect.sleep("100 millis")
            expect(onMessage).toHaveBeenCalledTimes(3)
          })
        ))

      it.effect("Should handle multiple messages in batch", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            const onMessage = vi.fn<(message: JetStreamMessage.JetStreamMessage) => void>()

            const consumerMessages = yield* consumer.consume()
            yield* Effect.fork(
              Stream.runForEach(consumerMessages.stream, (message) =>
                Effect.gen(function*() {
                  onMessage(message)
                  yield* message.ack
                }))
            )

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 1"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 2"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 3"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 4"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Message 5"))

            yield* Effect.sleep("200 millis")
            expect(onMessage).toHaveBeenCalledTimes(5)
          })
        ))

      it.effect("Should consume messages with fetch", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Fetch Message 1"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Fetch Message 2"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Fetch Message 3"))

            yield* Effect.sleep("100 millis")

            const fetched = yield* consumer.fetch({ max_messages: 3 })
            const messages = yield* Stream.runCollect(fetched.stream)
            const messagesArray = Chunk.toArray(messages)

            expect(messagesArray.length).toBe(3)
            expect(messagesArray[0].string()).toBe("Fetch Message 1")
            expect(messagesArray[1].string()).toBe("Fetch Message 2")
            expect(messagesArray[2].string()).toBe("Fetch Message 3")

            yield* Effect.all(messagesArray.map((msg) => msg.ack))
          })
        ))

      it.effect("Should handle JSON messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            interface TestPayload {
              id: number
              name: string
              timestamp: string
            }

            const payload: TestPayload = {
              id: 123,
              name: "test-payload",
              timestamp: new Date().toISOString()
            }

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode(JSON.stringify(payload)))
            yield* Effect.sleep("100 millis")

            const fetched = yield* consumer.fetch({ max_messages: 1 })
            const messages = yield* Stream.runCollect(fetched.stream)
            const messagesArray = Chunk.toArray(messages)

            expect(messagesArray.length).toBe(1)

            const receivedPayload = yield* messagesArray[0].json<TestPayload>()
            expect(receivedPayload).toEqual(payload)

            yield* messagesArray[0].ack
          })
        ))

      it.effect("Should handle message redelivery with nak", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Redelivery Test"))
            yield* Effect.sleep("100 millis")

            const fetched1 = yield* consumer.fetch({ max_messages: 1 })
            const messages1 = yield* Stream.runCollect(fetched1.stream)
            const messagesArray1 = Chunk.toArray(messages1)

            expect(messagesArray1.length).toBe(1)
            expect(messagesArray1[0].redelivered).toBe(false)

            yield* messagesArray1[0].nak()
            yield* Effect.sleep("100 millis")

            const fetched2 = yield* consumer.fetch({ max_messages: 1 })
            const messages2 = yield* Stream.runCollect(fetched2.stream)
            const messagesArray2 = Chunk.toArray(messages2)

            expect(messagesArray2.length).toBe(1)
            expect(messagesArray2[0].redelivered).toBe(true)
            expect(messagesArray2[0].string()).toBe("Redelivery Test")

            yield* messagesArray2[0].ack
          })
        ))

      it.effect("Should use next to get single messages", () =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* makeTestStreamAndConsumer()

            const client = yield* JetStreamClient.JetStreamClient
            const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)

            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Next Message 1"))
            yield* client.publish(TEST_SUBJECT, new TextEncoder().encode("Next Message 2"))

            yield* Effect.sleep("100 millis")

            const msg1Option = yield* consumer.next()
            expect(msg1Option._tag).toBe("Some")

            if (msg1Option._tag === "Some") {
              const msg1 = msg1Option.value
              expect(msg1.string()).toBe("Next Message 1")
              yield* msg1.ack
            }

            const msg2Option = yield* consumer.next()
            expect(msg2Option._tag).toBe("Some")

            if (msg2Option._tag === "Some") {
              const msg2 = msg2Option.value
              expect(msg2.string()).toBe("Next Message 2")
              yield* msg2.ack
            }
          })
        ))
    })
  })
})
