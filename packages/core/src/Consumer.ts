/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
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
 * @category models
 * @since 0.3.0
 */
export interface Consumer<A, M> {
  readonly [TypeId]: TypeId
  readonly serve: <E, R>(
    app: ConsumerApp.ConsumerApp<A, M, E, R>
  ) => Effect.Effect<void, ConsumerError.ConsumerError, Exclude<R, M>>
  readonly healthCheck: Effect.Effect<void, ConsumerError.ConsumerError, never>
}
