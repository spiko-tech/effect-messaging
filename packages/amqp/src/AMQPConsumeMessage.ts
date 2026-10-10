/**
 * @since 0.3.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type * as AMQPTypes from "./AMQPTypes.ts"

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPConsumeMessage {
  readonly content: Uint8Array
  readonly properties: AMQPTypes.MessageProperties
  readonly fields: {
    readonly consumerTag: string
    readonly deliveryTag: bigint
    readonly redelivered: boolean
    readonly exchange: string
    readonly routingKey: string
    readonly messageCount?: number
  }
}

/**
 * @category tags
 * @since 0.3.0
 */
export const AMQPConsumeMessage = Context.Service<AMQPConsumeMessage>("@effect-messaging/amqp/AMQPConsumeMessage")

/**
 * @since 0.3.0
 * @category Layers
 */
export const layer = (message: AMQPConsumeMessage): Layer.Layer<AMQPConsumeMessage> =>
  Layer.succeed(AMQPConsumeMessage, message)
