import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import { testJetStreamClient } from "./dependencies.js"

describe("JetStreamClient", () => {
  layer(testJetStreamClient)((it) => {
    it.effect("Should be able to create a JetStream client", () =>
      Effect.gen(function*() {
        const jetStreamclient = yield* JetStreamClient.JetStreamClient
        expect(jetStreamclient.apiPrefix).toEqual(expect.any(String))
      }))
  })
})
