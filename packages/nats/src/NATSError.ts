/**
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSError")

/**
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS Connection Error
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

/**
 * Represents a NATS Error
 *
 * @since 0.1.0
 * @category errors
 */
export class NATSError extends Schema.TaggedError<NATSError>()(
  "NATSError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}
