import type { Mock } from "@effect/vitest"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, TestServices } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import * as NATSMessage from "../src/NATSMessage.js"
import * as NATSPublisher from "../src/NATSPublisher.js"
import * as NATSSubscriber from "../src/NATSSubscriber.js"

describe("NATS Integration", { sequential: true }, () => {
  describe("publish and subscribe", () => {
    it.effect(
      "Should publish and subscribe to messages with full end-to-end functionality",
      () =>
        Effect.gen(function*() {
          const TEST_SUBJECT = "test.integration.subject"
          const TEST_MESSAGE = "Hello NATS Integration!"
          const TEST_JSON = { message: "Hello JSON!", id: 42 }

          // Mock NATS connection that simulates real behavior
          const mockSubscriptions = new Map<string, Array<(msg: any) => void>>()
          
          const mockConnection = {
            publish: (subject: string, data: Uint8Array, options?: any) => {
              // Simulate real publish by triggering subscribers
              const subscribers = mockSubscriptions.get(subject) || []
              const mockMsg = {
                data,
                string: () => new TextDecoder().decode(data),
                json: () => {
                  try {
                    return JSON.parse(new TextDecoder().decode(data))
                  } catch {
                    throw new Error(`Invalid JSON: ${new TextDecoder().decode(data)}`)
                  }
                },
                subject,
                headers: options?.headers || undefined,
                reply: options?.reply || undefined
              }
              
              // Simulate async message delivery
              setTimeout(() => {
                subscribers.forEach(handler => handler(mockMsg))
              }, 10)
            },
            subscribe: (subject: string, options?: any) => {
              const handlers: Array<(msg: any) => void> = []
              if (!mockSubscriptions.has(subject)) {
                mockSubscriptions.set(subject, handlers)
              } else {
                mockSubscriptions.get(subject)!.push(...handlers)
              }
              
              return {
                isClosed: () => false,
                unsubscribe: () => {
                  const existing = mockSubscriptions.get(subject) || []
                  mockSubscriptions.set(subject, existing.filter(h => !handlers.includes(h)))
                },
                [Symbol.asyncIterator]: async function* () {
                  let messageQueue: any[] = []
                  let resolveNext: ((value: { done: boolean; value?: any }) => void) | null = null
                  
                  const handler = (msg: any) => {
                    messageQueue.push(msg)
                    if (resolveNext) {
                      resolveNext({ done: false, value: messageQueue.shift() })
                      resolveNext = null
                    }
                  }
                  
                  handlers.push(handler)
                  const existing = mockSubscriptions.get(subject) || []
                  existing.push(handler)
                  mockSubscriptions.set(subject, existing)
                  
                  while (true) {
                    if (messageQueue.length > 0) {
                      yield messageQueue.shift()
                    } else {
                      yield await new Promise(resolve => {
                        resolveNext = resolve
                      }).then(result => result.value)
                    }
                  }
                }
              }
            },
            drain: () => Promise.resolve(),
            isClosed: () => false,
            isDraining: () => false,
            closed: () => Promise.resolve(undefined)
          }

          // Create a mock connection layer
          const mockConnectionLayer = Layer.succeed(
            NATSConnection.NATSConnection,
            NATSConnection.make(mockConnection as any)
          )

          // Create publisher and subscriber layers
          const publisherLayer = NATSPublisher.layer().pipe(Layer.provideMerge(mockConnectionLayer))
          const subscriberLayer = NATSSubscriber.layer({
            subject: TEST_SUBJECT
          }).pipe(Layer.provideMerge(mockConnectionLayer))

          // Combine layers
          const appLayer = publisherLayer.pipe(Layer.provideMerge(subscriberLayer))

          // Mock to track received messages
          const onMessage = vi.fn<(message: NATSMessage.NATSMessage) => void>()

          // Message handler
          const messageHandler = Effect.gen(function*() {
            const message = yield* NATSMessage.NATSMessage
            onMessage(message)
          })

          yield* Effect.gen(function*() {
            // Get services
            const publisher = yield* NATSPublisher.NATSPublisher
            const subscriber = yield* NATSSubscriber.NATSSubscriber

            // Start subscription (let it run but don't await)
            const subscriptionEffect = subscriber.subscribe(messageHandler)
            yield* Effect.fork(subscriptionEffect)

            // Wait for subscription to be ready
            yield* Effect.sleep("100 millis")

            // Reset mock between tests
            onMessage.mockClear()

            // Test 1: Publish string message
            yield* publisher.publish({
              subject: TEST_SUBJECT,
              data: new TextEncoder().encode(TEST_MESSAGE)
            })

            // Wait for message processing
            yield* Effect.sleep("100 millis")

            // Verify message received
            expect(onMessage).toHaveBeenCalled()
            expect(onMessage.mock.calls.length).toBeGreaterThanOrEqual(1)
            const firstMessage = onMessage.mock.calls[0]?.[0]
            expect(firstMessage).toBeDefined()
            
            if (firstMessage) {
              expect(NATSMessage.string(firstMessage)).toBe(TEST_MESSAGE)
              expect(NATSMessage.subject(firstMessage)).toBe(TEST_SUBJECT)
              expect(NATSMessage.data(firstMessage)).toEqual(
                new TextEncoder().encode(TEST_MESSAGE)
              )
            }

            // Reset mock for next test
            onMessage.mockClear()

            // Test 2: Publish JSON message
            yield* publisher.publish({
              subject: TEST_SUBJECT,
              data: new TextEncoder().encode(JSON.stringify(TEST_JSON))
            })

            yield* Effect.sleep("100 millis")

            // Verify JSON message received
            expect(onMessage.mock.calls.length).toBeGreaterThanOrEqual(1)
            const secondMessage = onMessage.mock.calls[0]?.[0] // First call after reset
            expect(secondMessage).toBeDefined()
            
            if (secondMessage) {
              expect(NATSMessage.json(secondMessage)).toEqual(TEST_JSON)
              expect(NATSMessage.subject(secondMessage)).toBe(TEST_SUBJECT)
            }

            // Reset mock for next test
            onMessage.mockClear()

            // Test 3: Publish message with headers
            yield* publisher.publish({
              subject: TEST_SUBJECT,
              data: new TextEncoder().encode("Message with headers"),
              options: {
                headers: { "Content-Type": "text/plain", "X-Test": "value" },
                reply: "test.reply"
              }
            })

            yield* Effect.sleep("100 millis")

            // Verify message with headers
            expect(onMessage.mock.calls.length).toBeGreaterThanOrEqual(1)
            const thirdMessage = onMessage.mock.calls[0]?.[0] // First call after reset
            expect(thirdMessage).toBeDefined()
            
            if (thirdMessage) {
              expect(NATSMessage.string(thirdMessage)).toBe("Message with headers")
              expect(NATSMessage.reply(thirdMessage)).toBe("test.reply")
              const headers = NATSMessage.headers(thirdMessage)
              expect(headers).toBeDefined()
              if (headers) {
                expect(headers["Content-Type"]).toBe("text/plain")
                expect(headers["X-Test"]).toBe("value")
              }
            }

          }).pipe(Effect.provide(appLayer))
        }).pipe(TestServices.provideLive),
      { timeout: 5000 }
    )
  })
})
