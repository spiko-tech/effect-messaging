/**
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import type * as SubscriberApp from "@effect-messaging/core/SubscriberApp"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as SubscriberOTel from "@effect-messaging/core/SubscriberOTel"
import * as SubscriberRunner from "@effect-messaging/core/SubscriberRunner"
import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import type { Options } from "amqplib"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as AMQPChannel from "./AMQPChannel.js"
import type * as AMQPConnection from "./AMQPConnection.js"
import * as AMQPConsumeMessage from "./AMQPConsumeMessage.js"
import type * as AMQPError from "./AMQPError.js"
import type * as AMQPSubscriberResponse from "./AMQPSubscriberResponse.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPSubscriber")

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
 * @since 0.5.0
 */
export type AMQPSubscriberApp<E, R> = SubscriberApp.SubscriberApp<
  AMQPSubscriberResponse.AMQPSubscriberResponse,
  AMQPConsumeMessage.AMQPConsumeMessage,
  E,
  R
>

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPSubscriber
  extends Subscriber.Subscriber<AMQPSubscriberResponse.AMQPSubscriberResponse, AMQPConsumeMessage.AMQPConsumeMessage>
{
  readonly [TypeId]: TypeId
}

const ATTR_MESSAGING_MESSAGE_CONVERSATION_ID = "messaging.message.conversation_id" as const
const ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY = "messaging.amqp.destination.routing_key" as const
const ATTR_MESSAGING_AMQP_MESSAGE_DELIVERY_TAG = "messaging.amqp.message.delivery_tag" as const
const ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME = "messaging.destination.subscription.name" as const

/** @internal */
const subscribe = (
  channel: AMQPChannel.AMQPChannel,
  queueName: string,
  connectionProperties: AMQPConnection.AMQPConnectionServerProperties,
  options: AMQPSubscriberOptions
) =>
<E, R>(app: AMQPSubscriberApp<E, R>) =>
  Effect.gen(function*() {
    const consumeStream = yield* channel.consume(
      queueName,
      options.concurrency ? { prefetch: options.concurrency } : undefined
    )
    return yield* SubscriberRunner.runStream(consumeStream, {
      name: "AMQPSubscriber",
      spanName: (message) => `amqp.consume ${message.fields.routingKey}`,
      parentSpan: (message) =>
        Option.getOrUndefined(
          HttpTraceContext.fromHeaders(Headers.fromInput(message.properties.headers))
        ),
      spanAttributes: (message) => ({
        [SubscriberOTel.SpanAttributes.SERVER_ADDRESS]: connectionProperties.host,
        [SubscriberOTel.SpanAttributes.SERVER_PORT]: connectionProperties.port,
        [SubscriberOTel.SpanAttributes.MESSAGING_MESSAGE_ID]: message.properties.messageId,
        [ATTR_MESSAGING_MESSAGE_CONVERSATION_ID]: message.properties.correlationId,
        [SubscriberOTel.SpanAttributes.MESSAGING_SYSTEM]: connectionProperties.product,
        [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: queueName,
        [SubscriberOTel.SpanAttributes.MESSAGING_DESTINATION_NAME]: queueName,
        [SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_TYPE]: "receive",
        [ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY]: message.fields.routingKey,
        [ATTR_MESSAGING_AMQP_MESSAGE_DELIVERY_TAG]: message.fields.deliveryTag
      }),
      handler: (message) => app.pipe(Effect.provide(AMQPConsumeMessage.layer(message))),
      options,
      onSuccess: (message, span) => (response) =>
        Match.valueTags(response, {
          Ack: () =>
            Effect.gen(function*() {
              span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "ack")
              yield* channel.ack(message)
            }),
          Nack: (r) =>
            Effect.gen(function*() {
              span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "nack")
              yield* channel.nack(message, r.allUpTo, r.requeue)
            }),
          Reject: (r) =>
            Effect.gen(function*() {
              span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "reject")
              yield* channel.reject(message, r.requeue)
            })
        }),
      onError: (message, span) => () =>
        Effect.gen(function*() {
          span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "nack")
          yield* channel.nack(message, false, false)
        })
    })
  })

/** @internal */
const healthCheck = (
  channel: AMQPChannel.AMQPChannel,
  queueName: string
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  channel.checkQueue(queueName).pipe(
    Effect.catchTag("AMQPChannelError", (error) =>
      new SubscriberError.SubscriberError({ reason: `Healthcheck failed`, cause: error })),
    Effect.asVoid
  )

/**
 * @category models
 * @since 0.5.0
 */
export interface AMQPSubscriberOptions extends SubscriberRunner.SubscriberRunnerOptions {
  concurrency?: number
}

/**
 * @category constructors
 * @since 0.3.0
 */
export const make = (
  queueName: string,
  options: AMQPSubscriberOptions = {}
): Effect.Effect<
  AMQPSubscriber,
  AMQPError.AMQPConnectionError,
  AMQPChannel.AMQPChannel
> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel
    const serverProperties = yield* channel.connection.serverProperties

    const subscriber: AMQPSubscriber = {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(channel, queueName, serverProperties, options),
      healthCheck: healthCheck(channel, queueName)
    }

    return subscriber
  })
