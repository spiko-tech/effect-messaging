/**
 * Optional @effect-messaging/core publisher adapter.
 * @since 0.3.0
 */
import * as Publisher from "@effect-messaging/core/Publisher"
import * as PublisherError from "@effect-messaging/core/PublisherError"
import * as Effect from "effect/Effect"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Schedule from "effect/Schedule"
import * as AMQPChannel from "./AMQPChannel.ts"
import type * as AMQPError from "./AMQPError.ts"
import type * as AMQPTypes from "./AMQPTypes.ts"

/** @since 0.3.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPPublisher")

/** @since 0.3.0 */
export interface AMQPPublishMessage {
  readonly exchange: string
  readonly routingKey: string
  readonly content: Uint8Array
  readonly options?: AMQPTypes.PublishOptions
}

/** @since 0.3.0 */
export interface AMQPPublisher extends Publisher.Publisher<AMQPPublishMessage> {
  readonly [TypeId]: typeof TypeId
}

/** @since 0.3.2 */
export interface AMQPPublisherConfig {
  /** Explicitly opting into retries can duplicate messages whose outcome is Unknown. */
  readonly retrySchedule?: Schedule.Schedule<unknown, AMQPError.AMQPError>
}

/** @since 0.3.0 */
export const make = (config: AMQPPublisherConfig = {}): Effect.Effect<AMQPPublisher, never, AMQPChannel.AMQPChannel> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel
    return {
      [TypeId]: TypeId,
      [Publisher.TypeId]: Publisher.TypeId,
      publish: (message: AMQPPublishMessage) =>
        Effect.useSpan(
          `amqp.publish ${message.routingKey}`,
          {
            kind: "producer",
            attributes: {
              "messaging.system": "rabbitmq",
              "messaging.operation.name": "publish",
              "messaging.operation.type": "send",
              "messaging.destination.name": message.exchange,
              "messaging.rabbitmq.destination.routing_key": message.routingKey,
              "messaging.message.id": message.options?.messageId
            }
          },
          (span) =>
            channel.publish(message.exchange, message.routingKey, message.content, {
              ...message.options,
              headers: { ...message.options?.headers, ...HttpTraceContext.toHeaders(span) }
            }).pipe(
              Effect.retry(config.retrySchedule ?? Schedule.recurs(0)),
              Effect.mapError((cause) =>
                new PublisherError.PublisherError({ reason: "Failed to publish message", cause })
              )
            )
        )
    }
  })
