/**
 * @since 0.3.0
 */
import * as Producer from "@effect-messaging/core/Producer"
import * as ProducerError from "@effect-messaging/core/ProducerError"
import type { Options } from "amqplib"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as AMQPChannel from "./AMQPChannel.js"
import type * as AMQPError from "./AMQPError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPProducer")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPPublishMessage {
  exchange: string
  routingKey: string
  content: Buffer
  options?: Options.Publish
}

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPProducer extends Producer.Producer<AMQPPublishMessage> {
  readonly [TypeId]: TypeId
}

/** @internal */
const publish = (
  channel: AMQPChannel.AMQPChannel,
  retrySchedule: Schedule.Schedule<unknown, AMQPError.AMQPChannelError>
) =>
(message: AMQPPublishMessage): Effect.Effect<void, ProducerError.ProducerError, never> =>
  channel.publish(message.exchange, message.routingKey, message.content, message.options).pipe(
    Effect.retry(retrySchedule),
    Effect.catchTag(
      "AMQPChannelError",
      (error) => Effect.fail(new ProducerError.ProducerError({ reason: "Failed to publish message", cause: error }))
    ),
    Effect.map(() => undefined)
  )

/**
 * @category constructors
 * @since 0.3.2
 */
export interface AMQPProducerConfig {
  readonly retrySchedule?: Schedule.Schedule<unknown, AMQPError.AMQPChannelError>
}

/**
 * @category constructors
 * @since 0.3.0
 */
export const make = (config?: AMQPProducerConfig): Effect.Effect<AMQPProducer, never, AMQPChannel.AMQPChannel> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel

    const producer: AMQPProducer = {
      [TypeId]: TypeId,
      [Producer.TypeId]: Producer.TypeId,
      send: publish(channel, config?.retrySchedule ?? Schedule.stop)
    }

    return producer
  })
