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
 * Represents a NATS Message Error
 *
 * @since 0.1.0
 * @category errors
 */
export class NATSMessageError extends Schema.TaggedError<NATSMessageError>()(
  "NATSMessageError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents a NATS Subscription Error
 *
 * @since 0.1.0
 * @category errors
 */
export class NATSSubscriptionError extends Schema.TaggedError<NATSSubscriptionError>()(
  "NATSSubscriptionError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents a NATS JetStreamClient Error
 *
 * @since 0.1.0
 * @category errors
 */
export class JetStreamClientError extends Schema.TaggedError<JetStreamClientError>()(
  "JetStreamClientError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents a NATS JetStreamManager Error
 *
 * @since 0.1.0
 * @category errors
 */
export class JetStreamManagerError extends Schema.TaggedError<JetStreamManagerError>()(
  "JetStreamManagerError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents a NATS JetStreamBatch Error
 *
 * @since 0.1.0
 * @category errors
 */
export class JetStreamBatchError extends Schema.TaggedError<JetStreamBatchError>()(
  "JetStreamBatchError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}
