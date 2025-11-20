import { describe, expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as JetStreamManager from "../src/JetStreamManager.js"
import { testJetStreamManager } from "./dependencies.js"

describe("JetStreamManager", () => {
  layer(testJetStreamManager)((it) => {
    it.effect("Should be able to create a JetStream manager", () =>
      Effect.gen(function*() {
        const jetStreamManager = yield* JetStreamManager.JetStreamManager
        const accountInfo = yield* jetStreamManager.accountInfo
        expect(accountInfo.streams).toEqual(expect.any(Number))
      }))
  })
})
