import { describe, expect, layer } from "@effect/vitest"
import { Effect, TestServices } from "effect"
import * as AMQPConnection from "../src/AMQPConnection.js"
import { simulateConnectionClose, testConnection } from "./dependencies.js"

describe("AMQPConnection", () => {
  layer(testConnection)("serverProperties", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const connection = yield* AMQPConnection.AMQPConnection

        expect(yield* connection.serverProperties).toMatchObject({
          hostname: "localhost",
          port: "5679",
          product: "RabbitMQ"
        })
      }))
  })

  layer(testConnection)("watchConnection", (it) => {
    it("Should reconnect the connection when close", () =>
      Effect.gen(function*() {
        const connection = yield* AMQPConnection.AMQPConnection
        expect(yield* connection.serverProperties).toMatchObject({ hostname: "localhost" })

        // Simulate connection close
        yield* simulateConnectionClose

        // should wait for connection to re-open and get server properties
        expect(yield* connection.serverProperties).toMatchObject({ hostname: "localhost" })
      }).pipe(TestServices.provideLive))
  })
})
