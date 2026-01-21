/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type * as ConsumerApp from "./ConsumerApp.js"
import type * as ConsumerError from "./ConsumerError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/Consumer")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * Types that are automatically provided to consumer handlers.
 *
 * @typeParam M - The message type provided via Effect context
 *
 * @category models
 * @since 0.8.0
 */
export type Provided<M> = M

/**
 * @category models
 * @since 0.3.0
 */
export interface Consumer<A, M> {
  readonly [TypeId]: TypeId

  /**
   * Serve the consumer application as a Layer.
   *
   * The returned Layer will run the consumer until the layer is released.
   * This is the recommended way to run consumers in production.
   *
   * @since 0.8.0
   */
  readonly serve: <E, R>(
    app: ConsumerApp.ConsumerApp<A, M, E, R>
  ) => Layer.Layer<never, ConsumerError.ConsumerError, Exclude<R, Provided<M>>>

  /**
   * Serve the consumer application as an Effect.
   *
   * The returned Effect will run the consumer until interrupted or an error occurs.
   * Requires a Scope to manage the consumer lifecycle.
   *
   * @since 0.8.0
   */
  readonly serveEffect: <E, R>(
    app: ConsumerApp.ConsumerApp<A, M, E, R>
  ) => Effect.Effect<void, ConsumerError.ConsumerError, Scope.Scope | Exclude<R, Provided<M>>>

  readonly healthCheck: Effect.Effect<void, ConsumerError.ConsumerError, never>
}
