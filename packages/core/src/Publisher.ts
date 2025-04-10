/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as PublisherError from "./PublisherError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/Publisher")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface Publisher<M> {
  readonly [TypeId]: TypeId
  readonly publish: (message: M) => Effect.Effect<void, PublisherError.PublisherError, never>
}
