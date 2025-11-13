import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as NATSJetStreamManager from "../src/NATSJetStreamManager.js"
import { testJetStreamManager } from "./dependencies.js"

describe("NATSJetStreamManager", () => {
  layer(testJetStreamManager)((it) => {
    it.effect("Should be able to create a JetStream manager", () =>
      Effect.gen(function*() {
        const jetStreamManager = yield* NATSJetStreamManager.NATSJetStreamManager
        const accountInfo = yield* jetStreamManager.accountInfo
        expect(accountInfo.streams).toEqual(expect.any(Number))
      }))
  })
})
