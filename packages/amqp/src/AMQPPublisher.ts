/**
 * @since 0.3.0
 */
import * as Publisher from "@effect-messaging/core/Publisher"
import * as PublisherError from "@effect-messaging/core/PublisherError"
import type { Options } from "amqplib"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as AMQPChannel from "./AMQPChannel.js"
import type * as AMQPError from "./AMQPError.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPPublisher")

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
export interface AMQPPublisher extends Publisher.Publisher<AMQPPublishMessage> {
  readonly [TypeId]: TypeId
}

/* @internal */
const publish = (
  channel: AMQPChannel.AMQPChannel,
  retrySchedule: Schedule.Schedule<unknown, AMQPError.AMQPChannelError>
) =>
(message: AMQPPublishMessage): Effect.Effect<void, PublisherError.PublisherError, never> =>
  channel.publish(message.exchange, message.routingKey, message.content, message.options).pipe(
    Effect.retry(retrySchedule),
    Effect.catchTag(
      "AMQPChannelError",
      (error) => Effect.fail(new PublisherError.PublisherError({ reason: "Failed to publish message", cause: error }))
    ),
    Effect.map(() => undefined)
  )

/**
 * @category constructors
 * @since 0.3.2
 */
export interface AMQPPublisherConfig {
  readonly retrySchedule?: Schedule.Schedule<unknown, AMQPError.AMQPChannelError>
}

/**
 * @category constructors
 * @since 0.3.0
 */
export const make = (config?: AMQPPublisherConfig): Effect.Effect<AMQPPublisher, never, AMQPChannel.AMQPChannel> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel

    const publisher: AMQPPublisher = {
      [TypeId]: TypeId,
      [Publisher.TypeId]: Publisher.TypeId,
      publish: publish(channel, config?.retrySchedule ?? Schedule.stop)
    }

    return publisher
  })
