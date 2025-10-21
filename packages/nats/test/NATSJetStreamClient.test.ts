import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as NATSJetStreamClient from "../src/NATSJetStreamClient.js"
import { testJetStreamClient } from "./dependencies.js"

describe("NATSJetStreamClient", () => {
  layer(testJetStreamClient)((it) => {
    it.effect("Should be able to create a JetStream client", () =>
      Effect.gen(function*() {
        const jetStreamclient = yield* NATSJetStreamClient.NATSJetStreamClient
        expect(jetStreamclient.apiPrefix).toEqual(expect.any(String))
      }))
  })
})
