/**
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPError")

/**
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents an AMQP Connection Error
 *
 * @since 0.1.0
 * @category errors
 */
export class NATSConnectionError extends Schema.TaggedError<NATSConnectionError>()(
  "NATSConnectionError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}
