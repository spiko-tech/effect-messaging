import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, TestServices } from "effect"
import * as AMQPConnection from "../src/AMQPConnection.js"
import { testConnection } from "./dependencies.js"

describe("AMQPConnection", () => {
  layer(testConnection)("serverProperties", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const connection = yield* AMQPConnection.AMQPConnection
        const serverProperties = yield* connection.serverProperties

        expect(serverProperties.hostname).toEqual("localhost")
        expect(serverProperties.port).toEqual("5679")
        expect(serverProperties.product).toEqual("RabbitMQ")
      }))
  })

  layer(testConnection)("watchConnection", (it) => {
    it("Should reconnect the connection when close", () =>
      Effect.gen(function*() {
        const connection = yield* AMQPConnection.AMQPConnection

        // Simulate connection close
        yield* connection.close({ removeAllListeners: false })

        // Connection should be closed
        expect(yield* connection.serverProperties.pipe(Effect.exit)).toStrictEqual(Exit.fail(expect.any))

        // Wait for reconnection
        yield* Effect.sleep("100 millis")

        const serverProperties = yield* connection.serverProperties
        expect(serverProperties.hostname).toEqual("localhost")
      }).pipe(TestServices.provideLive))
  })
})
