/**
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import type { Options } from "amqplib"
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as AMQPChannel from "./AMQPChannel.js"
import type * as AMQPConnection from "./AMQPConnection.js"
import * as AMQPConsumeMessage from "./AMQPConsumeMessage.js"
import type * as AMQPError from "./AMQPError.js"

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
 * @since 0.3.0
 */
export interface AMQPSubscriber extends Subscriber.Subscriber<AMQPConsumeMessage.AMQPConsumeMessage> {
  readonly [TypeId]: TypeId
}

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const
const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id" as const
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
<E, R>(
  handler: Effect.Effect<void, E, R | AMQPConsumeMessage.AMQPConsumeMessage>
) =>
  Effect.gen(function*() {
    const consumeStream = yield* channel.consume(queueName)
    return yield* consumeStream.pipe(
      Stream.runForEach((message) =>
        Effect.fork(
          Effect.useSpan(
            `amqp.consume ${message.fields.routingKey}`,
            {
              parent: Option.getOrUndefined(
                HttpTraceContext.fromHeaders(Headers.fromInput(message.properties.headers))
              ),
              kind: "consumer",
              captureStackTrace: false,
              attributes: {
                [ATTR_SERVER_ADDRESS]: connectionProperties.host,
                [ATTR_SERVER_PORT]: connectionProperties.port,
                [ATTR_MESSAGING_MESSAGE_ID]: message.properties.messageId,
                [ATTR_MESSAGING_MESSAGE_CONVERSATION_ID]: message.properties.correlationId,
                [ATTR_MESSAGING_SYSTEM]: connectionProperties.product,
                [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: queueName,
                [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
                [ATTR_MESSAGING_OPERATION_TYPE]: "receive",
                [ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY]: message.fields.routingKey,
                [ATTR_MESSAGING_AMQP_MESSAGE_DELIVERY_TAG]: message.fields.deliveryTag
              }
            },
            (span) =>
              Effect.gen(function*() {
                yield* Effect.logDebug(`amqp.consume ${message.fields.routingKey}`)
                yield* handler.pipe(
                  options.handlerTimeout
                    ? Effect.timeoutFail({
                      duration: options.handlerTimeout,
                      onTimeout: () =>
                        new SubscriberError.SubscriberError({ reason: `AMQPSubscriber: handler timed out` })
                    })
                    : Function.identity
                )
                span.attribute(ATTR_MESSAGING_OPERATION_NAME, "ack")
                yield* channel.ack(message)
              }).pipe(
                Effect.provide(AMQPConsumeMessage.layer(message)),
                Effect.tapErrorCause((cause) =>
                  Effect.gen(function*() {
                    yield* Effect.logError(Cause.pretty(cause))
                    span.attribute(ATTR_MESSAGING_OPERATION_NAME, "nack")
                    span.attribute(
                      "error.type",
                      Cause.squashWith(
                        cause,
                        (_) => Predicate.hasProperty(_, "tag") ? _.tag : _ instanceof Error ? _.name : `${_}`
                      )
                    )
                    span.attribute("error.stack", Cause.pretty(cause))
                    span.attribute(
                      "error.message",
                      Cause.squashWith(
                        cause,
                        (_) => Predicate.hasProperty(_, "reason") ? _.reason : _ instanceof Error ? _.message : `${_}`
                      )
                    )
                    yield* channel.nack(message, false, false)
                  })
                ),
                options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
                Effect.withParentSpan(span)
              )
          )
        )
      ),
      Effect.mapError((error) =>
        new SubscriberError.SubscriberError({ reason: `AMQPSubscriber failed to subscribe`, cause: error })
      )
    )
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
 * @since 0.4.0
 */
export interface AMQPSubscriberOptions {
  uninterruptible?: boolean
  handlerTimeout?: Duration.DurationInput
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
