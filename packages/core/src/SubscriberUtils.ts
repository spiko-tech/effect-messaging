/**
 * Utilities for building subscriber implementations with graceful drain
 * and handler timeout support.
 *
 * @since 0.3.0
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as SubscriberError from "./SubscriberError.js"

/**
 * Options for creating a handler runner with drain support.
 *
 * @since 0.3.0
 * @category models
 */
export interface HandlerRunnerOptions {
  readonly uninterruptible?: boolean | undefined
  readonly drainTimeout?: Duration.DurationInput | undefined
}

/**
 * A handler runner that tracks in-flight handler fibers and supports
 * graceful drain on scope finalization.
 *
 * @since 0.3.0
 * @category models
 */
export interface HandlerRunner {
  /**
   * Run a handler effect in the FiberSet. Returns `true` if the handler
   * was accepted, `false` if the runner is draining and new handlers are
   * rejected.
   */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<boolean, never, R>
  /**
   * Whether the runner is currently draining (waiting for in-flight
   * handlers to finish before shutdown).
   */
  readonly isDraining: Ref.Ref<boolean>
}

/**
 * Create a handler runner backed by a `FiberSet` that tracks in-flight
 * handler fibers and supports graceful drain on scope finalization.
 *
 * When `uninterruptible` is `true`, a finalizer is registered that:
 * 1. Sets a draining gate to reject new handlers
 * 2. Waits for all in-flight handlers to complete (optionally with a timeout)
 *
 * When `uninterruptible` is `false` (default), handlers are forked
 * normally and interrupted on scope close for fast shutdown.
 *
 * The returned effect is scoped — the FiberSet and drain finalizer
 * are tied to the enclosing scope.
 *
 * When both `uninterruptible` and `drainTimeout` are set, handler
 * effects are wrapped with `Effect.disconnect` so that the drain
 * timeout can actually race against in-flight handlers. Without
 * `disconnect`, the FiberSet scope close would block on
 * uninterruptible handlers even after the timeout fires.
 *
 * @since 0.3.0
 * @category constructors
 */
export const makeHandlerRunner = (
  options: HandlerRunnerOptions = {}
): Effect.Effect<HandlerRunner, never, Scope.Scope> =>
  Effect.gen(function*() {
    const fiberSet = yield* FiberSet.make<void>()
    const draining = yield* Ref.make(false)

    if (options.uninterruptible) {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* Ref.set(draining, true)
          yield* Effect.logDebug("SubscriberUtils: draining in-flight handlers")
          if (options.drainTimeout) {
            // Finalizers run in an uninterruptible context, so Effect.timeout
            // (which relies on interruption) does not work here. Instead, fork
            // two independent daemon fibers – one that waits for in-flight
            // handlers and one that sleeps for the drain timeout – and race
            // them through a shared Deferred. Daemon fibers are used so they
            // don't block scope cleanup when the finalizer returns.
            const done = yield* Deferred.make<void>()
            const awaitEmptyFiber = yield* Effect.forkDaemon(
              FiberSet.awaitEmpty(fiberSet).pipe(
                Effect.andThen(Deferred.succeed(done, undefined))
              )
            )
            const sleepFiber = yield* Effect.forkDaemon(
              Effect.sleep(options.drainTimeout).pipe(
                Effect.andThen(Deferred.succeed(done, undefined))
              )
            )
            yield* Deferred.await(done)
            yield* Fiber.interruptFork(awaitEmptyFiber)
            yield* Fiber.interruptFork(sleepFiber)
          } else {
            yield* FiberSet.awaitEmpty(fiberSet)
          }
          yield* Effect.logDebug("SubscriberUtils: all in-flight handlers drained")
        })
      )
    }

    const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<boolean, never, R> =>
      Effect.gen(function*() {
        if (options.uninterruptible && (yield* Ref.get(draining))) {
          return false
        }
        yield* FiberSet.run(
          fiberSet,
          effect.pipe(
            options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
            options.uninterruptible && options.drainTimeout ? Effect.disconnect : (_) => _,
            Effect.catchAllCause(() => Effect.void)
          )
        )
        return true
      })

    return { run, isDraining: draining } as HandlerRunner
  })

/**
 * Apply a timeout to a handler effect. When the handler is running in
 * an uninterruptible context, `Effect.timeoutFail` does not work
 * because it relies on interruption internally. This utility detects
 * the uninterruptible case and uses a Fiber-based race instead: the
 * handler is forked in an interruptible region so a timer fiber can
 * interrupt it.
 *
 * @since 0.3.0
 * @category combinators
 */
export const withTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly timeout: Duration.DurationInput
    readonly uninterruptible: boolean
    readonly timeoutMessage?: string
  }
): Effect.Effect<A, E | SubscriberError.SubscriberError, R> => {
  const message = options.timeoutMessage ?? "handler timed out"
  if (options.uninterruptible) {
    // Effect.timeoutFail relies on interruption internally, which does
    // not work inside Effect.uninterruptible. Fork the handler in an
    // interruptible region so the timeout can interrupt it, then map
    // the resulting interruption cause to a SubscriberError.
    return Effect.gen(function*() {
      const appFiber = yield* Effect.fork(Effect.interruptible(effect))
      const timerFiber = yield* Effect.fork(
        Effect.sleep(options.timeout).pipe(
          Effect.andThen(Fiber.interrupt(appFiber))
        )
      )
      return yield* Fiber.join(appFiber).pipe(
        Effect.onExit(() => Fiber.interrupt(timerFiber)),
        Effect.mapErrorCause((cause): Cause.Cause<E | SubscriberError.SubscriberError> =>
          Cause.isInterruptedOnly(cause)
            ? Cause.fail(
              new SubscriberError.SubscriberError({
                reason: message
              })
            )
            : cause
        )
      )
    }) as Effect.Effect<A, E | SubscriberError.SubscriberError, R>
  }
  return effect.pipe(
    Effect.timeoutFail({
      duration: options.timeout,
      onTimeout: () => new SubscriberError.SubscriberError({ reason: message })
    })
  )
}
