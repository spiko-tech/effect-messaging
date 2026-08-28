import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import { testConnection } from "./dependencies.js"

describe("NATSConnection", () => {
  describe("connection", () => {
    it.live("Should be able to connect", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect(connection.info).toMatchObject(Option.some({ port: 4222 }))
        yield* connection.flush
      }).pipe(Effect.provide(testConnection)))

    it.live("Should drain the connection when its layer scope closes", () =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(testConnection, scope)
        const connection = Context.get(context, NATSConnection.NATSConnection)

        expect(connection.nc.isClosed()).toBe(false)
        yield* Scope.close(scope, Exit.void)
        expect(connection.nc.isClosed()).toBe(true)
      }))

    it.live("Should be able to publish and subscribe to a subject", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection

        const subject = "test.subject"
        const message = "Hello, NATS!"

        const subscription = yield* connection.subscribe(subject)

        // Publish message after subscribing
        yield* Effect.forkChild(
          Effect.gen(function*() {
            yield* Effect.sleep("50 millis")
            yield* connection.publish(subject, message)
          })
        )

        // Take only one message from the stream
        const messages = yield* subscription.stream.pipe(
          Stream.take(1),
          Stream.runCollect
        )

        expect(messages.length).toBe(1)
        const receivedMessage = messages[0]
        expect(yield* receivedMessage.string).toBe("Hello, NATS!")
      }).pipe(Effect.provide(testConnection)))

    it.live("Should receive multiple messages in order", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subject = "test.multiple"

        const subscription = yield* connection.subscribe(subject)

        // Publish messages after subscribing
        yield* Effect.forkChild(
          Effect.gen(function*() {
            yield* Effect.sleep("50 millis")
            yield* connection.publish(subject, "Message 1")
            yield* connection.publish(subject, "Message 2")
            yield* connection.publish(subject, "Message 3")
          })
        )

        // Collect 3 messages
        const messages = yield* subscription.stream.pipe(
          Stream.take(3),
          Stream.mapEffect((msg) => msg.string),
          Stream.runCollect
        )

        expect(messages).toEqual(["Message 1", "Message 2", "Message 3"])
      }).pipe(Effect.provide(testConnection)))

    it.live("Should support wildcard subscriptions", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection

        const subscription = yield* connection.subscribe("test.wildcard.*")

        // Publish messages after subscribing
        yield* Effect.forkChild(
          Effect.gen(function*() {
            yield* Effect.sleep("50 millis")
            yield* connection.publish("test.wildcard.foo", "Message 1")
            yield* connection.publish("test.wildcard.bar", "Message 2")
            yield* connection.publish("other.baz", "Message 3") // Should not be received
          })
        )

        // Collect 2 messages (the third one should not match)
        const messages = yield* subscription.stream.pipe(
          Stream.take(2),
          Stream.runCollect
        )

        expect(messages.length).toBe(2)
      }).pipe(Effect.provide(testConnection)))
  })

  describe("request/reply", () => {
    it.live("Should support request/reply pattern", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subject = "test.request"

        const subscription = yield* connection.subscribe(subject)

        // Set up responder
        yield* Effect.forkChild(
          subscription.stream.pipe(
            Stream.take(1),
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
      }).pipe(Effect.provide(testConnection)))
  })
})
