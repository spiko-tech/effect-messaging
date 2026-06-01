import { describe, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream, TestServices, Tracer } from "effect"
import type * as Duration from "effect/Duration"
import type { StreamConfig } from "../src/internal/SubscriberRunner.js"
import * as SubscriberRunner from "../src/SubscriberRunner.js"

/** Minimal StreamConfig factory for unit-testing `runStream`. */
const makeConfig = <A, E = never>(opts: {
  handler: (message: string) => Effect.Effect<A, E>
  onSuccess?: (message: string) => (response: A) => Effect.Effect<void>
  onError?: (message: string) => () => Effect.Effect<void>
  handlerTimeout?: Duration.DurationInput
  newTracePerMessage?: boolean
  parentSpan?: (message: string) => Tracer.AnySpan | undefined
}): StreamConfig<string, A, E, never> => ({
  name: "TestSubscriber",
  spanName: (m: string) => `test.consume ${m}`,
  parentSpan: opts.parentSpan ?? (() => undefined),
  spanAttributes: () => ({}),
  handler: opts.handler,
  options: {
    ...(opts.handlerTimeout !== undefined ? { handlerTimeout: opts.handlerTimeout } : {}),
    ...(opts.newTracePerMessage !== undefined ? { newTracePerMessage: opts.newTracePerMessage } : {})
  },
  onSuccess: (_message: string, _span: Tracer.Span) => opts.onSuccess?.(_message) ?? (() => Effect.void),
  onError: (_message: string, _span: Tracer.Span) => opts.onError?.(_message) ?? (() => Effect.void)
})

describe("SubscriberRunner", { sequential: true }, () => {
  describe("handler behavior on interruption", () => {
    it.effect(
      "Should let in-flight handler complete on interrupt",
      () =>
        Effect.gen(function*() {
          const onHandlingStarted = vi.fn()
          const onHandlingFinished = vi.fn()

          const latch = yield* Deferred.make<void>()

          const config = makeConfig({
            handler: (_message) =>
              Effect.gen(function*() {
                onHandlingStarted()
                yield* Deferred.succeed(latch, void 0)
                yield* Effect.sleep("300 millis")
                onHandlingFinished()
              })
          })

          const fiber = yield* Effect.fork(SubscriberRunner.runStream(Stream.make("msg-1"), config))

          // Wait for handler to start
          yield* Deferred.await(latch)
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Interrupt the subscription fiber
          yield* fiber.interruptAsFork(fiber.id())

          // Handler should complete despite the interrupt (uninterruptible)
          yield* Effect.sleep("500 millis")
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )

    it.effect(
      "Should let in-flight handler complete on interrupt when handlerTimeout is configured",
      () =>
        Effect.gen(function*() {
          const onHandlingStarted = vi.fn()
          const onHandlingFinished = vi.fn()
          const onSuccess = vi.fn()

          const latch = yield* Deferred.make<void>()

          const config = makeConfig({
            handler: (_message) =>
              Effect.gen(function*() {
                onHandlingStarted()
                yield* Deferred.succeed(latch, void 0)
                yield* Effect.sleep("300 millis")
                onHandlingFinished()
                return "done"
              }),
            onSuccess: () => () => Effect.sync(() => onSuccess()),
            // handlerTimeout longer than handler duration — should not time out
            handlerTimeout: "2 seconds"
          })

          const fiber = yield* Effect.fork(SubscriberRunner.runStream(Stream.make("msg-1"), config))

          // Wait for handler to start
          yield* Deferred.await(latch)
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Interrupt the subscription fiber while handler is still running
          yield* fiber.interruptAsFork(fiber.id())

          // Handler should complete despite the interrupt
          yield* Effect.sleep("500 millis")
          expect(onHandlingFinished).toHaveBeenCalledTimes(1)
          expect(onSuccess).toHaveBeenCalledTimes(1)
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )

    it.effect(
      "Should interrupt the handler when it exceeds the timeout",
      () =>
        Effect.gen(function*() {
          const onHandlingStarted = vi.fn()
          const onHandlingFinished = vi.fn()
          const onError = vi.fn()

          const latch = yield* Deferred.make<void>()

          const config = makeConfig({
            handler: (_message) =>
              Effect.gen(function*() {
                onHandlingStarted()
                yield* Deferred.succeed(latch, void 0)
                // This will exceed the timeout
                yield* Effect.sleep("2 seconds")
                onHandlingFinished()
              }),
            onError: () => () => Effect.sync(() => onError()),
            handlerTimeout: "200 millis"
          })

          const fiber = yield* Effect.fork(SubscriberRunner.runStream(Stream.make("msg-1"), config))

          // Wait for handler to start
          yield* Deferred.await(latch)
          expect(onHandlingStarted).toHaveBeenCalledTimes(1)

          // Wait for timeout to trigger
          yield* Effect.sleep("500 millis")

          // Handler started but did not finish due to timeout
          expect(onHandlingFinished).toHaveBeenCalledTimes(0)
          expect(onError).toHaveBeenCalledTimes(1)

          yield* Fiber.interrupt(fiber)
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )
  })

  describe("handler callbacks", () => {
    it.effect(
      "Should call onSuccess after handler completes without timeout",
      () =>
        Effect.gen(function*() {
          const onSuccess = vi.fn()

          const config = makeConfig({
            handler: (_message) => Effect.succeed("result"),
            onSuccess: () => () => Effect.sync(() => onSuccess())
          })

          yield* SubscriberRunner.runStream(Stream.make("msg-1"), config)

          expect(onSuccess).toHaveBeenCalledTimes(1)
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )

    it.effect(
      "Should call onError when handler fails",
      () =>
        Effect.gen(function*() {
          const onError = vi.fn()
          const onSuccess = vi.fn()

          const config = makeConfig<never, Error>({
            handler: (_message) => Effect.fail(new Error("handler error")),
            onSuccess: () => () => Effect.sync(() => onSuccess()),
            onError: () => () => Effect.sync(() => onError())
          })

          yield* SubscriberRunner.runStream(Stream.make("msg-1"), config)

          expect(onError).toHaveBeenCalledTimes(1)
          expect(onSuccess).toHaveBeenCalledTimes(0)
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )
  })

  describe("newTracePerMessage option", () => {
    const PRODUCER_TRACE_ID = "abcdef1234567890abcdef1234567890"
    const PRODUCER_SPAN_ID = "1234567890abcdef"
    const producerSpan = Tracer.externalSpan({
      traceId: PRODUCER_TRACE_ID,
      spanId: PRODUCER_SPAN_ID,
      sampled: true
    })

    it.effect(
      "Should attach the linked span as a SpanLink and create a root span when enabled",
      () =>
        Effect.gen(function*() {
          const captured = yield* Deferred.make<Tracer.Span>()
          const config = makeConfig({
            handler: () =>
              Effect.gen(function*() {
                const span = yield* Effect.currentSpan
                yield* Deferred.succeed(captured, span)
                return "ok"
              }),
            newTracePerMessage: true,
            parentSpan: () => producerSpan
          })

          yield* SubscriberRunner.runStream(Stream.make("msg-1"), config)
          const capturedSpan = yield* Deferred.await(captured)

          expect(capturedSpan.traceId).not.toBe(PRODUCER_TRACE_ID)
          expect(capturedSpan.links.length).toBe(1)
          expect(capturedSpan.links[0]!.span.traceId).toBe(PRODUCER_TRACE_ID)
          expect(capturedSpan.links[0]!.span.spanId).toBe(PRODUCER_SPAN_ID)
          expect(capturedSpan.links[0]!.span.sampled).toBe(true)
          expect(capturedSpan.parent._tag).toBe("None")
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )

    it.effect(
      "Should create a root span without links when no linked span is provided",
      () =>
        Effect.gen(function*() {
          const captured = yield* Deferred.make<Tracer.Span>()
          const config = makeConfig({
            handler: () =>
              Effect.gen(function*() {
                const span = yield* Effect.currentSpan
                yield* Deferred.succeed(captured, span)
                return "ok"
              }),
            newTracePerMessage: true,
            parentSpan: () => undefined
          })

          yield* SubscriberRunner.runStream(Stream.make("msg-1"), config)
          const capturedSpan = yield* Deferred.await(captured)

          expect(capturedSpan.links.length).toBe(0)
          expect(capturedSpan.parent._tag).toBe("None")
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )

    it.effect(
      "Should use the linked span as parent when option is disabled (default)",
      () =>
        Effect.gen(function*() {
          const captured = yield* Deferred.make<Tracer.Span>()
          const config = makeConfig({
            handler: () =>
              Effect.gen(function*() {
                const span = yield* Effect.currentSpan
                yield* Deferred.succeed(captured, span)
                return "ok"
              }),
            parentSpan: () => producerSpan
          })

          yield* SubscriberRunner.runStream(Stream.make("msg-1"), config)
          const capturedSpan = yield* Deferred.await(captured)

          expect(capturedSpan.traceId).toBe(PRODUCER_TRACE_ID)
          expect(capturedSpan.links.length).toBe(0)
          expect(capturedSpan.parent._tag).toBe("Some")
        }).pipe(TestServices.provideLive),
      { timeout: 10000 }
    )
  })
})
