/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as SubscriberError from "./SubscriberError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/Subscriber")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface Subscriber<M> {
  readonly [TypeId]: TypeId
  readonly subscribe: <E, R>(
    handler: Effect.Effect<void, E, R | M>
  ) => Effect.Effect<void, SubscriberError.SubscriberError, R>
}
