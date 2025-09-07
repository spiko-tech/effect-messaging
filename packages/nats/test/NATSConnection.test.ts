import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import { testConnection } from "./dependencies.js"

describe("NATSConnection", () => {
  layer(testConnection)((it) => {
    it.effect("Should be able to connect", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect(connection.nc.info).toMatchObject({ port: 4222 })
      }))
  })
})
