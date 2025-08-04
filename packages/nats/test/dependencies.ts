import * as Effect from "effect/Effect"
import * as NATSConnection from "../src/NATSConnection.js"

export const testConnection = NATSConnection.layer({
  servers: ["nats://localhost:4222"]
})

export const TEST_SUBJECT = "test.subject"
export const TEST_REPLY_SUBJECT = "test.reply"

export const simulateConnectionClose = Effect.gen(function*() {
  const connection = yield* NATSConnection.NATSConnection
  yield* NATSConnection.close(connection)
})
