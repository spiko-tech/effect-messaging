import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as AMQPConnection from "../src/AMQPConnection.js"
import { testConnection } from "./dependencies.js"

layer(testConnection)("AMQPConnection", (it) => {
  it.effect("Should be able to connect and test server properties", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const serverProperties = yield* connection.serverProperties

      expect(serverProperties.hostname).toEqual("localhost")
      expect(serverProperties.port).toEqual("5679")
      expect(serverProperties.product).toEqual("RabbitMQ")
    }))
})
