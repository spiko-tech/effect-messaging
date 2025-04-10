/**
 * @since 0.3.0
 */
import type { ConsumeMessage } from "amqplib"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

export type AMQPConsumeMessage = ConsumeMessage

/**
 * @category tags
 * @since 0.3.0
 */
export const AMQPConsumeMessage = Context.GenericTag<AMQPConsumeMessage>("@effect-messaging/amqp/AMQPConsumeMessage")

/**
 * @since 0.3.0
 * @category Layers
 */
export const layer = (message: AMQPConsumeMessage): Layer.Layer<AMQPConsumeMessage> =>
  Layer.succeed(AMQPConsumeMessage, message)
