/**
 * @since 0.3.0
 */
import type * as Effect from "effect/Effect"
import type * as ProducerError from "./ProducerError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/Producer")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface Producer<M> {
  readonly [TypeId]: TypeId
  readonly send: (message: M) => Effect.Effect<void, ProducerError.ProducerError, never>
}
