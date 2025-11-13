import { describe, expect, layer } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import { testConnection } from "./dependencies.js"

describe("NATSConnection", () => {
  layer(testConnection)((it) => {
    it.effect("Should be able to connect", () =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect(connection.info).toMatchObject(Option.some({ port: 4222 }))
      }))
  })
})
