import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, TestServices } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import { AMQPChannelError } from "../src/AMQPError.js"
import {
  assertTestExchange,
  assertTestQueue,
  simulateChannelClose,
  simulateConnectionClose,
  testChannel
} from "./dependencies.js"

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

  describe("checkQueue", () => {
    it.effect("Should return a successful assertion of the queue", () =>
      Effect.gen(function*() {
        yield* assertTestQueue
        const channel = yield* AMQPChannel.AMQPChannel
        const result = yield* channel.checkQueue("TEST_QUEUE")
        expect(result).toMatchObject({
          queue: "TEST_QUEUE"
        })
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))

    it.effect("Should return an error when the queue does not exist", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const exit = yield* channel.checkQueue("NON_EXISTENT_QUEUE").pipe(Effect.exit)
        expect(exit).toStrictEqual(Exit.fail(expect.any(AMQPChannelError)))
      }).pipe(Effect.provide(testChannel), TestServices.provideLive))
  })
})
