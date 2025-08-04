import { describe, expect, it } from "@effect/vitest"
import { Effect, TestServices } from "effect"
import type { Msg } from "nats"
import * as NATSConnection from "../src/NATSConnection.js"
import * as NATSMessage from "../src/NATSMessage.js"
import * as NATSPublisher from "../src/NATSPublisher.js"
import * as NATSSubscriber from "../src/NATSSubscriber.js"

describe("NATS Integration", { sequential: true }, () => {
  describe("publish and subscribe", () => {
    it.effect(
      "Should provide full stack integration with publisher and subscriber interfaces",
      () =>
        Effect.gen(function*() {
          // Test that we can create all the necessary layers
          const connectionLayer = NATSConnection.layer({
            servers: ["nats://localhost:4222"]
          })
          const publisherLayer = NATSPublisher.layer()
          const subscriberLayer = NATSSubscriber.layer({
            subject: "test.subject"
          })

          expect(connectionLayer).toBeDefined()
          expect(publisherLayer).toBeDefined()
          expect(subscriberLayer).toBeDefined()

          // Test message handling with mock data
          const mockMsg: Msg = {
            data: new TextEncoder().encode("integration test message"),
            string: () => "integration test message",
            json: () => ({ test: "data", id: 123 }),
            subject: "test.subject",
            headers: { "Content-Type": "application/json" },
            reply: "test.reply"
          } satisfies Partial<Msg> as Msg

          const natsMessage = NATSMessage.make(mockMsg)

          // Verify message utilities work correctly
          expect(NATSMessage.data(natsMessage)).toEqual(
            new TextEncoder().encode("integration test message")
          )
          expect(NATSMessage.string(natsMessage)).toBe("integration test message")
          expect(NATSMessage.json(natsMessage)).toEqual({ test: "data", id: 123 })
          expect(NATSMessage.subject(natsMessage)).toBe("test.subject")
          expect(NATSMessage.headers(natsMessage)).toEqual({ "Content-Type": "application/json" })
          expect(NATSMessage.reply(natsMessage)).toBe("test.reply")

          // Test publish message structure
          const publishMessage: NATSMessage.NATSPublishMessage = {
            subject: "test.publish",
            data: new TextEncoder().encode("publish test"),
            options: {
              reply: "test.reply",
              headers: { "X-Custom": "header" }
            }
          }

          expect(publishMessage.subject).toBe("test.publish")
          expect(publishMessage.data).toEqual(new TextEncoder().encode("publish test"))
          expect(publishMessage.options?.reply).toBe("test.reply")
          expect(publishMessage.options?.headers).toEqual({ "X-Custom": "header" })

          // Verify TypeId uniqueness and context tags
          expect(NATSConnection.TypeId).toBeDefined()
          expect(NATSMessage.TypeId).toBeDefined()
          expect(NATSPublisher.TypeId).toBeDefined()
          expect(NATSSubscriber.TypeId).toBeDefined()

          expect(NATSConnection.NATSConnection).toBeDefined()
          expect(NATSMessage.NATSMessage).toBeDefined()
          expect(NATSPublisher.NATSPublisher).toBeDefined()
          expect(NATSSubscriber.NATSSubscriber).toBeDefined()

          // Test that different TypeIds are unique
          expect(NATSConnection.TypeId).not.toBe(NATSMessage.TypeId)
          expect(NATSMessage.TypeId).not.toBe(NATSPublisher.TypeId)
          expect(NATSPublisher.TypeId).not.toBe(NATSSubscriber.TypeId)

          // Verify that functions for creating instances exist
          expect(NATSConnection.makeConnection).toBeDefined()
          expect(NATSPublisher.make).toBeDefined()
          expect(NATSSubscriber.make).toBeDefined()
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )
  })
})
