import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Msg } from "nats"
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
    const mockMsg: Msg = {
      data: new TextEncoder().encode("test message"),
      string: () => "test message",
      json: () => ({ test: "data" }),
      subject: "test.subject",
      headers: undefined,
      reply: undefined
    } satisfies Partial<Msg> as Msg

    const natsMessage = NATSMessage.make(mockMsg)

    expect(NATSMessage.data(natsMessage)).toEqual(new TextEncoder().encode("test message"))
    expect(NATSMessage.string(natsMessage)).toBe("test message")
    expect(NATSMessage.json(natsMessage)).toEqual({ test: "data" })
    expect(NATSMessage.subject(natsMessage)).toBe("test.subject")
    expect(NATSMessage.headers(natsMessage)).toBeUndefined()
    expect(NATSMessage.reply(natsMessage)).toBeUndefined()
  })

  describe("NATSSubscriber", () => {
    describe("API structure", () => {
      it("should have proper subscriber interface structure", () => {
        const subscriberLayer = NATSSubscriber.layer({
          subject: "test.subject"
        })
        expect(subscriberLayer).toBeDefined()

        // Test that the layer can be created with different configurations
        const subscriberWithOptions = NATSSubscriber.layer({
          subject: "test.queue",
          options: { max: 10 }
        })
        expect(subscriberWithOptions).toBeDefined()
      })

      it("should handle different message types correctly", () => {
        // Test string message
        const stringMsg: Msg = {
          data: new TextEncoder().encode("hello world"),
          string: () => "hello world",
          json: () => "hello world",
          subject: "test.string",
          headers: undefined,
          reply: undefined
        } satisfies Partial<Msg> as Msg

        const stringMessage = NATSMessage.make(stringMsg)
        expect(NATSMessage.string(stringMessage)).toBe("hello world")

        // Test JSON message
        const jsonData = { id: 123, name: "test", active: true }
        const jsonMsg: Msg = {
          data: new TextEncoder().encode(JSON.stringify(jsonData)),
          string: () => JSON.stringify(jsonData),
          json: () => jsonData,
          subject: "test.json",
          headers: undefined,
          reply: undefined
        } satisfies Partial<Msg> as Msg

        const jsonMessage = NATSMessage.make(jsonMsg)
        expect(NATSMessage.json(jsonMessage)).toEqual(jsonData)

        // Test binary message
        const binaryData = new Uint8Array([1, 2, 3, 4, 5])
        const binaryMsg: Msg = {
          data: binaryData,
          string: () => "",
          json: () => null,
          subject: "test.binary",
          headers: undefined,
          reply: undefined
        } satisfies Partial<Msg> as Msg

        const binaryMessage = NATSMessage.make(binaryMsg)
        expect(NATSMessage.data(binaryMessage)).toEqual(binaryData)
      })

      it("should handle message with headers and reply", () => {
        const mockHeaders = { "Content-Type": "application/json", "X-Custom": "value" }
        const msgWithHeaders: Msg = {
          data: new TextEncoder().encode("test with headers"),
          string: () => "test with headers",
          json: () => ({ test: "data" }),
          subject: "test.headers",
          headers: mockHeaders,
          reply: "reply.subject"
        } satisfies Partial<Msg> as Msg

        const message = NATSMessage.make(msgWithHeaders)
        expect(NATSMessage.headers(message)).toBe(mockHeaders)
        expect(NATSMessage.reply(message)).toBe("reply.subject")
        expect(NATSMessage.subject(message)).toBe("test.headers")
      })

      it("should create proper message layer", () => {
        const mockMsg: Msg = {
          data: new TextEncoder().encode("layer test"),
          string: () => "layer test",
          json: () => ({ test: "layer" }),
          subject: "test.layer",
          headers: undefined,
          reply: undefined
        } satisfies Partial<Msg> as Msg

        const message = NATSMessage.make(mockMsg)
        const messageLayer = NATSMessage.layer(message)

        expect(messageLayer).toBeDefined()
      })
    })

    describe("Publisher interface", () => {
      it("should create publisher with default retry schedule", () => {
        const publisherLayer = NATSPublisher.layer()
        expect(publisherLayer).toBeDefined()
      })

      it("should create publisher with custom retry schedule", () => {
        const customSchedule = Effect.gen(function*() {
          yield* Effect.sleep("100 millis")
          return true
        })

        const publisherLayer = NATSPublisher.layer(customSchedule)
        expect(publisherLayer).toBeDefined()
      })

      it("should validate publish message structure", () => {
        // Test basic publish message
        const basicMessage: NATSMessage.NATSPublishMessage = {
          subject: "test.basic"
        }
        expect(basicMessage.subject).toBe("test.basic")
        expect(basicMessage.data).toBeUndefined()
        expect(basicMessage.options).toBeUndefined()

        // Test message with data
        const messageWithData: NATSMessage.NATSPublishMessage = {
          subject: "test.data",
          data: new TextEncoder().encode("hello")
        }
        expect(messageWithData.subject).toBe("test.data")
        expect(messageWithData.data).toEqual(new TextEncoder().encode("hello"))

        // Test message with options
        const messageWithOptions: NATSMessage.NATSPublishMessage = {
          subject: "test.options",
          data: new TextEncoder().encode("hello"),
          options: {
            reply: "reply.subject",
            headers: { "Content-Type": "text/plain" }
          }
        }
        expect(messageWithOptions.options?.reply).toBe("reply.subject")
        expect(messageWithOptions.options?.headers).toEqual({ "Content-Type": "text/plain" })
      })
    })

    describe("Connection interface", () => {
      it("should create connection layer with basic options", () => {
        const connectionLayer = NATSConnection.layer({
          servers: ["nats://localhost:4222"]
        })
        expect(connectionLayer).toBeDefined()
      })

      it("should create connection layer with advanced options", () => {
        const connectionLayer = NATSConnection.layer({
          servers: ["nats://server1:4222", "nats://server2:4222"],
          name: "test-connection",
          timeout: 5000,
          maxReconnectAttempts: 10
        })
        expect(connectionLayer).toBeDefined()
      })

      it("should create connection layer with retry schedule", () => {
        const retrySchedule = Effect.gen(function*() {
          yield* Effect.sleep("1 second")
          return true
        })

        const connectionLayer = NATSConnection.layer(
          { servers: ["nats://localhost:4222"] },
          retrySchedule
        )
        expect(connectionLayer).toBeDefined()
      })
    })

    describe("Error handling", () => {
      it("should have proper error types available", () => {
        // Test that we can import and reference the error types
        expect(NATSConnection.makeConnection).toBeDefined()
        expect(NATSPublisher.make).toBeDefined()
        expect(NATSSubscriber.make).toBeDefined()
      })
    })

    describe("Type safety", () => {
      it("should maintain type safety through the interfaces", () => {
        // Test TypeId symbols are unique
        expect(NATSConnection.TypeId).toBeDefined()
        expect(NATSMessage.TypeId).toBeDefined()
        expect(NATSPublisher.TypeId).toBeDefined()
        expect(NATSSubscriber.TypeId).toBeDefined()

        // Test that TypeIds are different
        expect(NATSConnection.TypeId).not.toBe(NATSMessage.TypeId)
        expect(NATSMessage.TypeId).not.toBe(NATSPublisher.TypeId)
        expect(NATSPublisher.TypeId).not.toBe(NATSSubscriber.TypeId)
      })

      it("should provide proper context tags", () => {
        expect(NATSConnection.NATSConnection).toBeDefined()
        expect(NATSMessage.NATSMessage).toBeDefined()
        expect(NATSPublisher.NATSPublisher).toBeDefined()
        expect(NATSSubscriber.NATSSubscriber).toBeDefined()
      })
    })
  })
})
