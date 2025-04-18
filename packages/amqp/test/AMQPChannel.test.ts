import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import { assertTestExchange, simulateChannelClose, simulateConnectionClose, testChannel } from "./dependencies.js"

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

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should reconnect the channel when the connection is close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateConnectionClose

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })
})
