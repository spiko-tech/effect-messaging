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
import * as AMQPError from "./AMQPError.ts"
import type * as AMQPTypes from "./AMQPTypes.ts"
import * as Normalize from "./internal/normalizeOptions.ts"

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

/**
 * Creates a publisher using the provided channel. Its lifetime cannot exceed that channel's scope.
 * Completion follows the channel's write/confirmation mode; retries are disabled by default.
 * @since 0.3.0
 * @category constructors
 */
export const make = Effect.fn("AMQPPublisher.make")(function*(
  config: AMQPPublisherConfig = {}
): Effect.fn.Return<AMQPPublisher, never, AMQPChannel.AMQPChannel> {
  const channel = yield* AMQPChannel.AMQPChannel
  return {
    [TypeId]: TypeId,
    [Publisher.TypeId]: Publisher.TypeId,
    publish: Effect.fn("AMQPPublisher.publish")(function*(message: AMQPPublishMessage) {
      const input = yield* Effect.try({
        try: () => ({
          exchange: message.exchange,
          routingKey: message.routingKey,
          content: message.content,
          options: message.options
        }),
        catch: (cause) => new AMQPError.AMQPProtocolError({ reason: "Cannot read publication input", cause })
      })
      const options = yield* Normalize.publish(input.options ?? {})
      return yield* Effect.useSpan(
        `amqp.publish ${input.routingKey}`,
        {
          kind: "producer",
          attributes: {
            "messaging.system": "rabbitmq",
            "messaging.operation.name": "publish",
            "messaging.operation.type": "send",
            "messaging.destination.name": input.exchange,
            "messaging.rabbitmq.destination.routing_key": input.routingKey,
            "messaging.message.id": options.messageId
          }
        },
        (span) =>
          channel.publish(input.exchange, input.routingKey, input.content, {
            ...options,
            headers: { ...options.headers, ...HttpTraceContext.toHeaders(span) }
          }).pipe(
            Effect.retry(config.retrySchedule ?? Schedule.recurs(0))
          )
      )
    }, Effect.mapError((cause) => new PublisherError.PublisherError({ reason: "Failed to publish message", cause })))
  }
})
