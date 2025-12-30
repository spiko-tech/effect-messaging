/**
 * @since 0.3.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/core/ProducerError")

/**
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a generic Producer Error
 *
 * @since 0.3.0
 * @category errors
 */
export class ProducerError extends Schema.TaggedError<ProducerError>()(
  "ProducerError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.3.0
   */
  readonly [TypeId] = TypeId
}
