import { describe, expect, it } from "vitest"
import * as NATSConnection from "../src/NATSConnection.js"
import * as NATSMessage from "../src/NATSMessage.js"
import * as NATSPublisher from "../src/NATSPublisher.js"
import * as NATSSubscriber from "../src/NATSSubscriber.js"

describe("NATS Integration", () => {
  it("should create types and interfaces correctly", () => {
    // Test that we can create the layers without actually connecting
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
  })

  it("should handle NATS message operations", () => {
    // Mock message for testing utilities
    const mockMsg = {
      data: new TextEncoder().encode("test message"),
      string: () => "test message",
      json: () => ({ test: "data" }),
      subject: "test.subject",
      headers: undefined,
      reply: undefined
    } as any

    const natsMessage = NATSMessage.make(mockMsg)

    expect(NATSMessage.data(natsMessage)).toEqual(new TextEncoder().encode("test message"))
    expect(NATSMessage.string(natsMessage)).toBe("test message")
    expect(NATSMessage.json(natsMessage)).toEqual({ test: "data" })
    expect(NATSMessage.subject(natsMessage)).toBe("test.subject")
    expect(NATSMessage.headers(natsMessage)).toBeUndefined()
    expect(NATSMessage.reply(natsMessage)).toBeUndefined()
  })
})
