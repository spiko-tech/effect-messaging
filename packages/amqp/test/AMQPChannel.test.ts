import { describe, expect, it, layer } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
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
  layer(testChannel, { excludeTestServices: true })("connection", (it) => {
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
    it.live("Should reconnect the channel when close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateChannelClose

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel)))

    it.live("Should reconnect the channel when the connection is close", () =>
      Effect.gen(function*() {
        yield* assertTestExchange

        // Simulate channel close
        yield* simulateConnectionClose

        // should wait for channel to re-open and assert exchange
        yield* assertTestExchange
      }).pipe(Effect.provide(testChannel)))
  })

  describe("checkQueue", () => {
    it.live("Should return a successful assertion of the queue", () =>
      Effect.gen(function*() {
        yield* assertTestQueue
        const channel = yield* AMQPChannel.AMQPChannel
        const result = yield* channel.checkQueue("TEST_QUEUE")
        expect(result).toMatchObject({
          queue: "TEST_QUEUE"
        })
      }).pipe(Effect.provide(testChannel)))

    it.live("Should return an error when the queue does not exist", () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const exit = yield* channel.checkQueue("NON_EXISTENT_QUEUE").pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(AMQPChannelError)
      }).pipe(Effect.provide(testChannel)))
  })
})
