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
  })
})
