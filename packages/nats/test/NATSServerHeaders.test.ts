import { describe, expect, it } from "@effect/vitest"
import { headers } from "@nats-io/nats-core"
import { Effect, Option, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSPublisher from "../src/NATSPublisher.ts"
import { testConnection } from "./dependencies.ts"

describe("NATS server-owned headers", () => {
  it.live("delivers the message without a forged Nats-Request-Info header", () =>
    Effect.gen(function*() {
      const publisher = yield* NATSPublisher.make()
      const connection = yield* NATSConnection.NATSConnection
      const subject = `test.server-headers.${Date.now()}`
      const subscription = yield* connection.subscribe(subject)
      const outgoing = headers()
      outgoing.set("Nats-Request-Info", "{\"user\":\"forged\"}")
      outgoing.set("Nats-Trace-Hop", "9")
      outgoing.set("x-app", "orders")

      yield* Effect.forkChild(
        Effect.gen(function*() {
          yield* Effect.sleep("50 millis")
          yield* publisher.publish({
            subject,
            payload: "order-1",
            options: { headers: outgoing }
          })
        })
      )

      const messages = yield* subscription.stream.pipe(Stream.take(1), Stream.runCollect)
      const message = messages[0]
      const received = Option.getOrThrow(message.headers)

      expect(yield* message.string).toBe("order-1")
      expect(received.has("Nats-Request-Info")).toBe(false)
      expect(received.has("Nats-Trace-Hop")).toBe(false)
      expect(received.get("x-app")).toBe("orders")
    }).pipe(Effect.provide(testConnection)))
})
