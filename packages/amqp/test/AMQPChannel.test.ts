import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import { assertTestExchange, simulateChannelClose, testChannel } from "./dependencies.js"

describe("AMQPChannel", () => {
  layer(testChannel)("connection", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel

        expect(yield* channel.connection.serverProperties).toMatchObject({
          hostname: "localhost",
          port: "5679",
          product: "RabbitMQ"
        })
      }))
  })

  describe("watchChannel", () => {
    it.effect("Should reconnect the channel when close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateChannelClose

        // channel should be closed
        expect(yield* assertTestExchange.pipe(Effect.exit))
          .toStrictEqual(Exit.fail(expect.anything()))

        // Wait for reconnection
        yield* Effect.sleep("50 millis")

        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should reconnect the channel when the connection is close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateChannelClose

        // channel should be closed
        expect(yield* assertTestExchange.pipe(Effect.exit))
          .toStrictEqual(Exit.fail(expect.anything()))

        // Wait for reconnection - this is a bit longer than the channel close
        yield* Effect.sleep("2000 millis")

        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })
})
