import { AMQPConnection } from "@effect-messaging/amqp"
import { assert, describe, it } from "@effect/vitest"

describe("AMQPConnection", () => {
  it("Dummy test", () => {
    assert.equal(AMQPConnection.TypeId, AMQPConnection.TypeId)
  })
})
