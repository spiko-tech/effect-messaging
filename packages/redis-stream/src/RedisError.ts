/**
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/redis-stream/RedisError")

/**
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a Redis Connection Error
 *
 * @since 0.1.0
 * @category errors
 */
export class RedisConnectionError extends Schema.TaggedError<RedisConnectionError>()(
  "RedisConnectionError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Represents a Redis Stream Error
 *
 * @since 0.1.0
 * @category errors
 */
export class RedisStreamError extends Schema.TaggedError<RedisStreamError>()(
  "RedisStreamError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect) }
) {
  /**
   * @since  0.1.0
   */
  readonly [TypeId] = TypeId
}
