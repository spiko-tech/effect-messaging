import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.js"
import { testChannel } from "./dependencies.js"

layer(testChannel)("AMQPChannel", (it) => {
  it.effect("Should be able to connect and test server properties", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const serverProperties = yield* channel.connection.serverProperties

      expect(serverProperties.hostname).toEqual("localhost")
      expect(serverProperties.port).toEqual("5679")
      expect(serverProperties.product).toEqual("RabbitMQ")
    }))
})
