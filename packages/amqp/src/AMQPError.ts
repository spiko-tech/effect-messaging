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
export class AMQPConnectionError extends Schema.TaggedError<AMQPConnectionError>()(
  "AMQPConnectionError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    replyCode: Schema.optional(Schema.Number),
    classId: Schema.optional(Schema.Number),
    methodId: Schema.optional(Schema.Number),
    permanent: Schema.optional(Schema.Boolean)
  }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents an AMQP Channel Error
 *
 * @since 0.1.0
 * @category errors
 */
export class AMQPChannelError extends Schema.TaggedError<AMQPChannelError>()(
  "AMQPChannelError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    replyCode: Schema.optional(Schema.Number),
    classId: Schema.optional(Schema.Number),
    methodId: Schema.optional(Schema.Number)
  }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Malformed or unsupported AMQP wire data.
 * @since 0.8.0
 */
export class AMQPProtocolError extends Schema.TaggedError<AMQPProtocolError>()(
  "AMQPProtocolError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) }
) {}

/**
 * An Unknown outcome must not be automatically retried unless duplicates are acceptable.
 * @since 0.8.0
 */
export class AMQPPublishError extends Schema.TaggedError<AMQPPublishError>()(
  "AMQPPublishError",
  {
    reason: Schema.String,
    outcome: Schema.Literals(["NotSent", "Unknown", "Nacked"]),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * A delivery belongs to a retired channel, or has already been settled.
 * @since 0.8.0
 */
export class AMQPSettlementError extends Schema.TaggedError<AMQPSettlementError>()(
  "AMQPSettlementError",
  { reason: Schema.String, kind: Schema.Literals(["Stale", "AlreadySettled"]), cause: Schema.optional(Schema.Defect()) }
) {}

/** @since 0.8.0 */
export type AMQPError =
  | AMQPConnectionError
  | AMQPChannelError
  | AMQPProtocolError
  | AMQPPublishError
  | AMQPSettlementError
