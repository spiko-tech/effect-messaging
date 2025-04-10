/**
 * @since 0.3.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/SubscriberError")

/**
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a generic Publisher Error
 *
 * @since 0.3.0
 * @category errors
 */
export class SubscriberError extends Schema.TaggedError<SubscriberError>()(
  "SubscriberError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.3.0
   */
  readonly [TypeId] = TypeId
}
