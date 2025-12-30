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
 * Type alias for a subscriber handler function that processes messages.
 *
 * @typeParam A - The response type that the handler must return (e.g., acknowledgment response)
 * @typeParam M - The message type that the handler receives via Effect context
 * @typeParam E - The error type that the handler may fail with
 * @typeParam R - Additional dependencies required by the handler (excluding the message type M)
 *
 * @since 0.3.0
 * @category models
 */
export type SubscriberApp<A, M, E = never, R = never> = Effect.Effect<A, E, R | M>

/**
 * @category models
 * @since 0.3.0
 */
export interface Subscriber<A, M> {
  readonly [TypeId]: TypeId
  readonly subscribe: <E, R>(
    app: SubscriberApp<A, M, E, R>
  ) => Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, M>>
  readonly healthCheck: Effect.Effect<void, SubscriberError.SubscriberError, never>
}
