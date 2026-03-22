/**
 * Shared subscriber stream consumption logic.
 *
 * Encapsulates the per-message handling pipeline used by all subscriber
 * implementations (AMQP, JetStream, NATS Core). Each subscriber calls
 * `runStream` to drive the stream consumption loop, which internally uses
 * `executeHandler` for per-message handler execution.
 *
 * All handlers run uninterruptibly, matching the original behavior.
 *
 * @internal
 * @since 0.3.0
 */
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import type * as Tracer from "effect/Tracer"
import * as SubscriberError from "../SubscriberError.js"
import * as SubscriberOTel from "./SubscriberOTel.js"

/**
 * Shared subscriber options that control timeout behavior.
 *
 * @since 0.3.0
 * @category models
 */
export interface SubscriberRunnerOptions {
  readonly handlerTimeout?: Duration.DurationInput
}

/**
 * Configuration for `runStream`. Each subscriber provides transport-specific
 * callbacks while the shared logic drives the stream consumption loop with forked
 * span-wrapped handler execution.
 *
 * @since 0.3.0
 * @category models
 */
export interface StreamConfig<M, A, E, R, EX = never, RX = never> {
  /** Subscriber name used in error messages, e.g. "AMQPSubscriber" */
  readonly name: string
  /** Derive span name from a message (also used as log prefix) */
  readonly spanName: (message: M) => string
  /** Extract parent span from message headers for trace propagation */
  readonly parentSpan: (message: M) => Tracer.AnySpan | undefined
  /** Build OTel span attributes from a message */
  readonly spanAttributes: (message: M) => Record<string, unknown>
  /** Build the handler effect for a message (with message layer already provided) */
  readonly handler: (message: M) => Effect.Effect<A, E, R>
  /** Subscriber options controlling timeout behavior */
  readonly options: SubscriberRunnerOptions
  /** Called on successful handler completion. Receives the message and current span. */
  readonly onSuccess: (message: M, span: Tracer.Span) => (response: A) => Effect.Effect<void, EX, RX>
  /** Called on handler error. Receives the message and current span. */
  readonly onError: (message: M, span: Tracer.Span) => () => Effect.Effect<void, EX, RX>
}

/**
 * Creates a per-message handler from a stream config. The returned function
 * accepts a message and span and runs the handler pipeline: timeout wrapping,
 * success/error dispatch, error span attributes, and uninterruptible execution.
 *
 * @since 0.3.0
 * @category execution
 */
const executeHandler = <M, A, E, R, EX, RX>(
  config: StreamConfig<M, A, E, R, EX, RX>
) =>
(message: M, span: Tracer.Span): Effect.Effect<void, E | EX | SubscriberError.SubscriberError, R | RX> => {
  const handler = config.handler(message)

  // When handlerTimeout is set, fork the handler into a detached (daemon) fiber
  // so it is interruptible by the timeout but not by parent fiber interruption
  // (e.g. SIGINT / graceful shutdown).
  const handlerEffect: Effect.Effect<A, E | SubscriberError.SubscriberError, R> = config.options.handlerTimeout
    ? Effect.forkDaemon(Effect.interruptible(handler)).pipe(
      Effect.flatMap((handlerFiber) =>
        Effect.forkDaemon(
          Effect.interruptible(
            Effect.andThen(
              Effect.sleep(config.options.handlerTimeout!),
              Fiber.interrupt(handlerFiber)
            )
          )
        ).pipe(
          Effect.flatMap((timerFiber) =>
            Fiber.join(handlerFiber).pipe(
              Effect.onExit(() => Fiber.interrupt(timerFiber)),
              Effect.catchAllCause((cause): Effect.Effect<never, E | SubscriberError.SubscriberError> =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.fail(
                    new SubscriberError.SubscriberError({ reason: `${config.name}: handler timed out` })
                  )
                  : Effect.failCause(cause)
              )
            )
          )
        )
      )
    )
    : handler

  const handleErrorCause = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function*() {
      yield* Effect.logError(Cause.pretty(cause))
      SubscriberOTel.setErrorSpanAttributes(span, cause)
      yield* config.onError(message, span)()
    })

  const body = Effect.gen(function*() {
    yield* Effect.logDebug(config.spanName(message))
    const response = yield* handlerEffect
    yield* config.onSuccess(message, span)(response)
  })

  return body.pipe(
    Effect.tapErrorCause(handleErrorCause),
    Effect.uninterruptible,
    Effect.withParentSpan(span),
    Effect.asVoid
  )
}

/**
 * Runs a message stream, forking each message into a span-wrapped handler
 * execution pipeline.
 *
 * This is the shared stream consumption loop used by all subscriber implementations.
 * It handles:
 * - `Stream.runForEach` with `Effect.fork` for concurrent message processing
 * - `Effect.useSpan` for OTel trace context propagation
 * - Delegation to `executeHandler` for timeout, error handling, and uninterruptible execution
 * - `Effect.mapError` to wrap transport-specific stream errors into `SubscriberError`
 *
 * @since 0.3.0
 * @category execution
 */
export const runStream: <M, ES, RS, A, E, R, EX, RX>(
  stream: Stream.Stream<M, ES, RS>,
  config: StreamConfig<M, A, E, R, EX, RX>
) => Effect.Effect<void, SubscriberError.SubscriberError, RS | R | RX> = <M, ES, RS, A, E, R, EX, RX>(
  stream: Stream.Stream<M, ES, RS>,
  config: StreamConfig<M, A, E, R, EX, RX>
) => {
  const handle = executeHandler(config)
  return stream.pipe(
    Stream.runForEach((message) =>
      Effect.fork(
        Effect.useSpan(
          config.spanName(message),
          {
            parent: config.parentSpan(message),
            kind: "consumer",
            captureStackTrace: false,
            attributes: config.spanAttributes(message)
          },
          (span) => handle(message, span)
        )
      )
    ),
    Effect.mapError((error) =>
      new SubscriberError.SubscriberError({ reason: `${config.name} failed to subscribe`, cause: error })
    )
  )
}
