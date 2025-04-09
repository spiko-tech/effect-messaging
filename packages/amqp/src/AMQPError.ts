import { Schema } from "effect"

/**
 * @since 0.2.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPError")

/**
 * @since 0.2.0
 */
export type TypeId = typeof TypeId

/**
 * Represents an AMQP Connection Error
 *
 * @since 0.2.0
 * @category errors
 */
export class AMQPConnectionError extends Schema.TaggedError<AMQPConnectionError>()(
  "AMQPConnectionError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.2.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents an AMQP Channel Error
 *
 * @since 0.2.0
 * @category errors
 */
export class AMQPChannelError extends Schema.TaggedError<AMQPChannelError>()(
  "AMQPChannelError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.2.0
   */
  readonly [TypeId] = TypeId
}
