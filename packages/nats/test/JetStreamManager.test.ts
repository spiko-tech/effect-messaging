import { describe, expect, it, layer } from "@effect/vitest"
import { Chunk, Effect, Stream, TestServices } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import * as JetStreamManager from "../src/JetStreamManager.js"
import { makeTestConsumer, makeTestStream, makeTestStreamAndConsumer, testJetStream } from "./dependencies.js"

// Use unique names for this test file to avoid conflicts with other test files
const TEST_STREAM = "MANAGER_TEST_STREAM"
const TEST_CONSUMER = "MANAGER_TEST_CONSUMER"
const TEST_SUBJECT = "manager.test.subject"

describe("JetStreamManager", { sequential: true }, () => {
  describe("basic operations", () => {
    layer(testJetStream)((it) => {
      it.effect("Should be able to create a JetStream manager", () =>
        Effect.gen(function*() {
          const jetStreamManager = yield* JetStreamManager.JetStreamManager
          const accountInfo = yield* jetStreamManager.accountInfo
          expect(accountInfo.streams).toEqual(expect.any(Number))
        }))
    })
  })

  describe("stream management and publish/consume", () => {
    it.effect("Should create a stream, publish messages, and consume them", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* makeTestStreamAndConsumer(TEST_STREAM, TEST_CONSUMER, [TEST_SUBJECT])

          const client = yield* JetStreamClient.JetStreamClient

          yield* client.publish(TEST_SUBJECT, "Manager Test Message 1")
          yield* client.publish(TEST_SUBJECT, "Manager Test Message 2")
          yield* client.publish(TEST_SUBJECT, "Manager Test Message 3")

          yield* Effect.sleep("100 millis")

          const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
          const fetched = yield* consumer.fetch({ max_messages: 3, expires: 5000 })
          const messages = yield* fetched.stream.pipe(
            Stream.take(3),
            Stream.runCollect
          )
          const messagesArray = Chunk.toArray(messages)

          expect(messagesArray.length).toBe(3)
          expect(messagesArray[0].string()).toBe("Manager Test Message 1")
          expect(messagesArray[1].string()).toBe("Manager Test Message 2")
          expect(messagesArray[2].string()).toBe("Manager Test Message 3")

          yield* Effect.all(messagesArray.map((msg) => msg.ack))
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))

    it.effect("Should list streams and consumers", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* makeTestStreamAndConsumer(TEST_STREAM, TEST_CONSUMER, [TEST_SUBJECT])

          const manager = yield* JetStreamManager.JetStreamManager

          const streamLister = yield* manager.streams.list()
          const streams = yield* Stream.runCollect(streamLister.stream)
          const streamsArray = Chunk.toArray(streams)

          expect(streamsArray.length).toBeGreaterThan(0)
          expect(streamsArray.some((s) => s.config.name === TEST_STREAM)).toBe(true)

          const consumerLister = yield* manager.consumers.list(TEST_STREAM)
          const consumers = yield* Stream.runCollect(consumerLister.stream)
          const consumersArray = Chunk.toArray(consumers)

          expect(consumersArray.length).toBeGreaterThan(0)
          expect(consumersArray.some((c) => c.name === TEST_CONSUMER)).toBe(true)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))

    it.effect("Should get stream info and consumer info", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* makeTestStreamAndConsumer(TEST_STREAM, TEST_CONSUMER, [TEST_SUBJECT])

          const manager = yield* JetStreamManager.JetStreamManager
          const client = yield* JetStreamClient.JetStreamClient

          const streamInfo = yield* manager.streams.info(TEST_STREAM)
          expect(streamInfo.config.name).toBe(TEST_STREAM)
          expect(streamInfo.state.messages).toBe(0)

          yield* client.publish(TEST_SUBJECT, "Info Test")
          yield* Effect.sleep("50 millis")

          const updatedStreamInfo = yield* manager.streams.info(TEST_STREAM)
          expect(updatedStreamInfo.state.messages).toBe(1)

          const consumerInfo = yield* manager.consumers.info(TEST_STREAM, TEST_CONSUMER)
          expect(consumerInfo.name).toBe(TEST_CONSUMER)
          expect(consumerInfo.num_pending).toBeGreaterThan(0)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))

    it.effect("Should purge stream messages", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const manager = yield* JetStreamManager.JetStreamManager
          const client = yield* JetStreamClient.JetStreamClient

          yield* makeTestStream(TEST_STREAM, [TEST_SUBJECT])

          yield* client.publish(TEST_SUBJECT, "Purge Test 1")
          yield* client.publish(TEST_SUBJECT, "Purge Test 2")
          yield* client.publish(TEST_SUBJECT, "Purge Test 3")

          yield* Effect.sleep("100 millis")

          const streamInfo = yield* manager.streams.info(TEST_STREAM)
          expect(streamInfo.state.messages).toBe(3)

          const purgeResponse = yield* manager.streams.purge(TEST_STREAM)
          expect(purgeResponse.purged).toBe(3)

          const purgedStreamInfo = yield* manager.streams.info(TEST_STREAM)
          expect(purgedStreamInfo.state.messages).toBe(0)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))

    it.effect("Should update stream configuration", () =>
      Effect.scoped(
        Effect.gen(function*() {
          yield* makeTestStream(TEST_STREAM, [TEST_SUBJECT])

          const manager = yield* JetStreamManager.JetStreamManager

          const updatedStreamInfo = yield* manager.streams.update(TEST_STREAM, {
            max_msgs: 2000
          })

          expect(updatedStreamInfo.config.max_msgs).toBe(2000)
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))

    it.effect("Should handle consumer with multiple subjects", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const subject1 = "test.multi.1"
          const subject2 = "test.multi.2"

          yield* makeTestStream(TEST_STREAM, [subject1, subject2])
          yield* makeTestConsumer(TEST_STREAM, TEST_CONSUMER)

          const client = yield* JetStreamClient.JetStreamClient

          yield* client.publish(subject1, "Message on subject 1")
          yield* client.publish(subject2, "Message on subject 2")

          yield* Effect.sleep("100 millis")

          const consumer = yield* client.consumers.get(TEST_STREAM, TEST_CONSUMER)
          const fetched = yield* consumer.fetch({ max_messages: 2, expires: 5000 })
          const messages = yield* fetched.stream.pipe(
            Stream.take(2),
            Stream.runCollect
          )
          const messagesArray = Chunk.toArray(messages)

          expect(messagesArray.length).toBe(2)
          expect(messagesArray[0].subject).toBe(subject1)
          expect(messagesArray[1].subject).toBe(subject2)

          yield* Effect.all(messagesArray.map((msg) => msg.ack))
        })
      ).pipe(Effect.provide(testJetStream), TestServices.provideLive))
  })
})
