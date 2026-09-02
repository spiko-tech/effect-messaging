import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Publisher from "../src/Publisher.js"

describe("Publisher", () => {
  it("retains nominal identity", () => {
    const publisher: Publisher.Publisher<string> = {
      [Publisher.TypeId]: Publisher.TypeId,
      publish: () => Effect.void
    }

    assert.equal(publisher[Publisher.TypeId], Publisher.TypeId)
  })
})
