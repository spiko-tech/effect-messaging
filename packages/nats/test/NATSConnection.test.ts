import { describe, expect, layer, vi } from "@effect/vitest"
import { Effect, Option, Stream, TestServices } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import type * as NATSMessage from "../src/NATSMessage.js"
import { testConnection } from "./dependencies.js"

layer(testConnection)("NATSConnection", (it) => {
  describe("info", () => {
    it.effect("Should be able to connect", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect(connection.info).toMatchObject(Option.some({ port: 4222 }))
      }))
  })

  describe("publish/subscribe", () => {
    it.effect("Should be able to publish and subscribe to a subject", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection

        const subject = "test.subject"
        const message = "Hello, NATS!"

        const subscription = yield* connection.subscribe(subject)

        const onMessage = vi.fn<(message: NATSMessage.NATSMessage) => void>()
        const messageHandler = (message: NATSMessage.NATSMessage) =>
          Effect.gen(function*() {
            onMessage(message)
            return yield* Effect.void
          })

        yield* Effect.fork(subscription.stream.pipe(Stream.runForEach(messageHandler)))

        yield* connection.publish(subject, message)

        // Wait for the message to be consumed
        yield* Effect.sleep("100 millis")

        expect(onMessage).toHaveBeenCalledTimes(1)
        const receivedMessage = onMessage.mock.calls[0][0]
        expect(yield* receivedMessage.string).toStrictEqual("Hello, NATS!")
      }).pipe(Effect.provide(testConnection), TestServices.provideLive), { timeout: 5000 })

    it.effect("Should receive multiple messages in order", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subject = "test.multiple"

        const subscription = yield* connection.subscribe(subject)
        const receivedMessages: Array<string> = []

        const messageHandler = (message: NATSMessage.NATSMessage) =>
          Effect.gen(function*() {
            const content = yield* message.string
            receivedMessages.push(content)
          })

        yield* Effect.fork(subscription.stream.pipe(Stream.runForEach(messageHandler)))

        // Publish multiple messages
        yield* connection.publish(subject, "Message 1")
        yield* connection.publish(subject, "Message 2")
        yield* connection.publish(subject, "Message 3")

        yield* Effect.sleep("50 millis")

        expect(receivedMessages).toEqual(["Message 1", "Message 2", "Message 3"])
      }).pipe(Effect.provide(testConnection), TestServices.provideLive), { timeout: 5000 })

    it.effect("Should support wildcard subscriptions", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection

        const subscription = yield* connection.subscribe("test.*")
        const onMessage = vi.fn<(message: NATSMessage.NATSMessage) => void>()

        yield* Effect.fork(
          subscription.stream.pipe(Stream.runForEach((msg) => Effect.sync(() => onMessage(msg))))
        )

        yield* connection.publish("test.foo", "Message 1")
        yield* connection.publish("test.bar", "Message 2")
        yield* connection.publish("other.baz", "Message 3")

        yield* Effect.sleep("50 millis")

        expect(onMessage).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(testConnection), TestServices.provideLive), { timeout: 5000 })
  })

  describe("request/reply", () => {
    it.effect("Should support request/reply pattern", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subject = "test.request"

        const subscription = yield* connection.subscribe(subject)

        // Set up responder
        yield* Effect.fork(
          subscription.stream.pipe(
            Stream.runForEach((msg) =>
              Effect.gen(function*() {
                const request = yield* msg.string
                yield* msg.respond(`Echo: ${request}`)
              })
            )
          )
        )

        yield* Effect.sleep("50 millis")

        // Send request
        const response = yield* connection.request(subject, "Hello")
        const responseText = yield* response.string

        expect(responseText).toEqual("Echo: Hello")
      }).pipe(Effect.provide(testConnection), TestServices.provideLive), { timeout: 5000 })

    it.effect("Should support requestMany pattern for multiple responses", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subject = "test.requestMany"

        // Set up multiple responders
        const responder1 = yield* connection.subscribe(subject)
        const responder2 = yield* connection.subscribe(subject)
        const responder3 = yield* connection.subscribe(subject)

        yield* Effect.fork(
          responder1.stream.pipe(
            Stream.runForEach((msg) =>
              Effect.gen(function*() {
                const request = yield* msg.string
                yield* msg.respond(`Responder 1: ${request}`)
              })
            )
          )
        )

        yield* Effect.fork(
          responder2.stream.pipe(
            Stream.runForEach((msg) =>
              Effect.gen(function*() {
                const request = yield* msg.string
                yield* msg.respond(`Responder 2: ${request}`)
              })
            )
          )
        )

        yield* Effect.fork(
          responder3.stream.pipe(
            Stream.runForEach((msg) =>
              Effect.gen(function*() {
                const request = yield* msg.string
                yield* msg.respond(`Responder 3: ${request}`)
              })
            )
          )
        )

        yield* Effect.sleep("50 millis")

        // Send request and collect multiple responses
        const responseStream = yield* connection.requestMany(subject, "Hello")
        const responses = yield* Stream.runCollect(
          responseStream.pipe(
            Stream.take(3),
            Stream.mapEffect((msg) => msg.string)
          )
        )

        const responseTexts = Array.from(responses)

        // Should receive responses from all three responders
        expect(responseTexts.length).toBe(3)
        expect(responseTexts).toContain("Responder 1: Hello")
        expect(responseTexts).toContain("Responder 2: Hello")
        expect(responseTexts).toContain("Responder 3: Hello")
      }).pipe(Effect.provide(testConnection), TestServices.provideLive), { timeout: 10000 })
  })
})
