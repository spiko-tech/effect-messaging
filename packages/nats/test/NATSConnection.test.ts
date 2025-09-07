import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import { testConnection } from "./dependencies.js"

describe("NATSConnection", () => {
  layer(testConnection)("serverProperties", (it) => {
    it.effect("Should be able to connect and test server properties", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        console.log(connection.nc.info)
        expect(connection.nc.info).toMatchObject({ port: 4222 })
      }))
  })
})
