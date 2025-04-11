import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import * as AMQPConnection from "../src/AMQPConnection.js"
import { assertTestExchange, testChannel } from "./dependencies.js"

describe("AMQPChannel", () => {
  layer(testChannel)("connection", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const serverProperties = yield* channel.connection.serverProperties

        expect(serverProperties.hostname).toEqual("localhost")
        expect(serverProperties.port).toEqual("5679")
        expect(serverProperties.product).toEqual("RabbitMQ")
      }))
  })

  describe("watchChannel", () => {
    it.effect("Should reconnect the channel when close", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        yield* assertTestExchange

        // Simulate channel close
        yield* channel.close({ removeAllListeners: false })

        // channel should be closed
        expect(yield* assertTestExchange.pipe(Effect.exit))
          .toStrictEqual(Exit.fail(expect.anything()))

        // Wait for reconnection
        yield* Effect.sleep("50 millis")

        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should reconnect the channel when the connection is close", () =>
      Effect.gen(function*() {
        const connection = yield* AMQPConnection.AMQPConnection
        yield* assertTestExchange

        // Simulate channel close
        yield* connection.close({ removeAllListeners: false })

        // channel should be closed
        expect(yield* assertTestExchange.pipe(Effect.exit))
          .toStrictEqual(Exit.fail(expect.anything()))

        // Wait for reconnection - this is a bit longer than the channel close
        yield* Effect.sleep("2000 millis")

        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })
})
