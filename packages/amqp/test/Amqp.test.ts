import { Amqp } from "@effect-messaging/amqp"
import { assert, describe, it } from "@effect/vitest"

describe("amqp", () => {
  it("should work", () => {
    assert.equal(Amqp.amqp, "amqp")
  })
})
