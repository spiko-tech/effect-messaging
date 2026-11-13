/**
 * @since 0.3.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type * as AMQPTypes from "./AMQPTypes.ts"

/**
 * One received body and its AMQP properties. Delivery tags belong to the receiving
 * physical channel; retain the message itself when settling, not a copied tag.
 * Automatically acknowledged deliveries have no later settlement authority.
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
 * Provides a delivery to a subscriber handler for that handler's lifetime.
 * @category tags
 * @since 0.3.0
 */
export const AMQPConsumeMessage = Context.Service<AMQPConsumeMessage>("@effect-messaging/amqp/AMQPConsumeMessage")

/**
 * A layer supplying one delivery to an Effect handler.
 * @since 0.3.0
 * @category Layers
 */
export const layer = (message: AMQPConsumeMessage): Layer.Layer<AMQPConsumeMessage> =>
  Layer.succeed(AMQPConsumeMessage, message)
