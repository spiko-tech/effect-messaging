/**
 * @since 0.3.0
 */
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type * as Tracer from "effect/Tracer"
import * as SubscriberOTel from "./internal/SubscriberOTel.ts"
import * as SubscriberError from "./SubscriberError.ts"

/**
 * Transport callbacks and admission policy for one stream worker owner.
 * @since 0.8.0
 * @category models
 */
export interface StreamConfig<M, A, E, R, EX = never, RX = never> {
  readonly name: string
  readonly spanName: (message: M) => string
  readonly parentSpan: (message: M) => Tracer.AnySpan | undefined
  readonly spanAttributes: (message: M) => Record<string, unknown>
  readonly handler: (message: M) => Effect.Effect<A, E, R>
  readonly options: SubscriberRunnerOptions
  readonly onSuccess: (message: M, span: Tracer.Span) => (response: A) => Effect.Effect<void, EX, RX>
  readonly onError: (message: M, span: Tracer.Span) => () => Effect.Effect<void, EX, RX>
  /** Positive maximum in-flight handlers, shared across the entire stream lifetime. Omit for unbounded admission. */
  readonly concurrency?: number
  /** Rechecked after admission, immediately before constructing the handler or its span. */
  readonly isActive?: (message: M) => boolean
}

const executeHandler = Effect.fnUntraced(function*<M, A, E, R, EX, RX>(
  config: StreamConfig<M, A, E, R, EX, RX>,
  message: M,
  span: Tracer.Span
) {
  const handler = config.handler(message)
  const timeout = config.options.handlerTimeout
  const handlerEffect = timeout === undefined ? handler : Effect.gen(function*() {
    const appFiber = yield* Effect.forkDetach(Effect.interruptible(handler))
    const timerFiber = yield* Effect.forkDetach(
      Effect.interruptible(Effect.sleep(timeout).pipe(Effect.andThen(Fiber.interrupt(appFiber))))
    )
    return yield* Fiber.join(appFiber).pipe(
      Effect.onExit(() => Fiber.interrupt(timerFiber)),
      Effect.catchCause((cause): Effect.Effect<A, E | SubscriberError.SubscriberError> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.fail(new SubscriberError.SubscriberError({ reason: `${config.name}: handler timed out` }))
          : Effect.failCause(cause)
      )
    )
  })
  yield* Effect.gen(function*() {
    yield* Effect.logDebug(config.spanName(message))
    const response = yield* handlerEffect
    yield* config.onSuccess(message, span)(response)
  }).pipe(
    Effect.tapCause(Effect.fnUntraced(function*(cause) {
      yield* Effect.logError(Cause.pretty(cause))
      SubscriberOTel.setErrorSpanAttributes(span, cause)
      yield* config.onError(message, span)()
    })),
    Effect.uninterruptible,
    Effect.withParentSpan(span)
  )
})

const processMessage = Effect.fnUntraced(function*<M, A, E, R, EX, RX>(
  config: StreamConfig<M, A, E, R, EX, RX>,
  message: M
) {
  if (config.isActive !== undefined && !config.isActive(message)) return
  const parentSpan = config.parentSpan(message)
  const base = {
    kind: "consumer",
    captureStackTrace: false,
    attributes: config.spanAttributes(message)
  } as const
  const spanOptions: Tracer.SpanOptions = config.options.producerSpanRelation === "parent"
    ? { ...base, parent: parentSpan }
    : {
      ...base,
      root: true,
      links: parentSpan === undefined ? [] : [{ span: parentSpan, attributes: {} }]
    }
  yield* Effect.useSpan(config.spanName(message), spanOptions, (span) => executeHandler(config, message, span))
})

/**
 * @since 0.3.0
 * @category execution
 */
export const runStream = Effect.fnUntraced(function*<M, ES, RS, A, E, R, EX, RX>(
  stream: Stream.Stream<M, ES, RS>,
  config: StreamConfig<M, A, E, R, EX, RX>
): Effect.fn.Return<void, SubscriberError.SubscriberError, RS | R | RX> {
  yield* Effect.gen(function*() {
    // The source owns its own scope: cancel consumption before draining this worker owner.
    const handlers = yield* FiberSet.make<void>()
    const permits = config.concurrency === undefined ? undefined : yield* Semaphore.make(config.concurrency)
    const admit = Effect.fnUntraced(function*(message: M) {
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          if (permits !== undefined) yield* restore(permits.take(1))
          yield* processMessage(config, message).pipe(
            Effect.ignoreCause,
            Effect.ensuring(permits === undefined ? Effect.void : permits.release(1)),
            FiberSet.run(handlers)
          )
        })
      )
    })
    yield* Stream.runForEach(stream, admit).pipe(
      Effect.mapError((cause) =>
        new SubscriberError.SubscriberError({ reason: `${config.name} failed to subscribe`, cause })
      )
    )
    yield* FiberSet.awaitEmpty(handlers)
  }).pipe(Effect.scoped)
})

/**
 * @since 0.3.0
 * @category models
 */
export interface SubscriberRunnerOptions {
  readonly handlerTimeout?: Duration.Input
  /**
   * "link" (default) starts a root consumer span linked to the producer.
   * "parent" continues the producer's trace.
   */
  readonly producerSpanRelation?: "parent" | "link"
}
