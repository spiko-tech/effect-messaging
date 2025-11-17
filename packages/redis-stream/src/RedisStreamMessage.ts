/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisStreamMessage {
  readonly id: string
  readonly timestamp: number
  readonly data: Record<string, string>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const RedisStreamMessage = Context.GenericTag<RedisStreamMessage>(
  "@effect-messaging/redis-stream/RedisStreamMessage"
)

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (message: RedisStreamMessage): Layer.Layer<RedisStreamMessage> =>
  Layer.succeed(RedisStreamMessage, message)
