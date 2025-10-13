/**
 * @since 0.1.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as RedisConnection from "./RedisConnection.js"
import * as RedisError from "./RedisError.js"
import * as RedisStreamMessage from "./RedisStreamMessage.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/redis-stream/RedisStreamSubscriber")

/**
 * @category tags
 * @since 0.1.0
 */
export const RedisStreamSubscriber = Context.GenericTag<RedisStreamSubscriber>(
  "@effect-messaging/redis-stream/RedisStreamSubscriber"
)

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisStreamSubscriber extends Subscriber.Subscriber<RedisStreamMessage.RedisStreamMessage> {
  readonly [TypeId]: TypeId
}

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const
const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id" as const
const ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME = "messaging.destination.subscription.name" as const

/** @internal */
const subscribe = (
  connection: RedisConnection.RedisConnection,
  streamName: string,
  options: RedisStreamSubscriberOptions
) =>
<E, R>(
  handler: Effect.Effect<void, E, R | RedisStreamMessage.RedisStreamMessage>
) =>
  Effect.gen(function*() {
    const client = yield* connection.client.pipe(
      Effect.catchTag(
        "RedisConnectionError",
        (error) => Effect.fail(new SubscriberError.SubscriberError({ reason: "Connection failed", cause: error }))
      )
    )
    let lastId = "0" // Start from the beginning

    const consumeStream = Stream.repeatEffect(
      Effect.gen(function*() {
        const result = yield* Effect.tryPromise({
          try: () =>
            client.xRead({
              key: streamName,
              id: lastId
            }, {
              BLOCK: options.blockTimeout ?? 1000,
              COUNT: options.count ?? 10
            }),
          catch: (error) => new RedisError.RedisStreamError({ reason: "Failed to read from stream", cause: error })
        })

        if (result) {
          const streamData = result[0]
          if (streamData && streamData.messages.length > 0) {
            lastId = streamData.messages[streamData.messages.length - 1].id
            return streamData.messages.map((msg: any) => ({
              id: msg.id,
              timestamp: parseInt(msg.id.split("-")[0], 10),
              data: msg.message
            }))
          }
        }
        return []
      })
    )

    return yield* consumeStream.pipe(
      Stream.flatMap((messages) => Stream.fromIterable(messages)),
      Stream.runForEach((message: any) =>
        Effect.fork(
          Effect.useSpan(
            `redis.xread ${streamName}`,
            {
              kind: "consumer",
              captureStackTrace: false,
              attributes: {
                [ATTR_SERVER_ADDRESS]: "localhost", // Could be enhanced to get from connection
                [ATTR_SERVER_PORT]: 6379,
                [ATTR_MESSAGING_MESSAGE_ID]: message.id,
                [ATTR_MESSAGING_SYSTEM]: "redis",
                [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: streamName,
                [ATTR_MESSAGING_DESTINATION_NAME]: streamName,
                [ATTR_MESSAGING_OPERATION_TYPE]: "receive"
              }
            },
            (span) =>
              Effect.gen(function*() {
                yield* Effect.logDebug(`redis.xread ${streamName} - ${message.id}`)
                yield* handler.pipe(
                  options.handlerTimeout
                    ? Effect.timeoutFail({
                      duration: options.handlerTimeout,
                      onTimeout: () =>
                        new SubscriberError.SubscriberError({ reason: `RedisStreamSubscriber: handler timed out` })
                    })
                    : Function.identity
                )
                // Automatic ACK - no explicit acknowledgment needed with XREAD
                span.attribute(ATTR_MESSAGING_OPERATION_NAME, "ack")
              }).pipe(
                Effect.provide(RedisStreamMessage.layer(message as any)),
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
                    // With XREAD, we don't requeue failed messages
                  })
                ),
                options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
                Effect.withParentSpan(span)
              )
          )
        )
      ),
      Effect.mapError((error) =>
        new SubscriberError.SubscriberError({ reason: `RedisStreamSubscriber failed to subscribe`, cause: error })
      )
    )
  })

/** @internal */
const healthCheck = (
  connection: RedisConnection.RedisConnection,
  streamName: string
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  Effect.gen(function*() {
    const client = yield* connection.client.pipe(
      Effect.catchTag(
        "RedisConnectionError",
        (error) => Effect.fail(new SubscriberError.SubscriberError({ reason: "Connection failed", cause: error }))
      )
    )
    yield* Effect.tryPromise({
      try: () => client.exists(streamName),
      catch: (error) => new RedisError.RedisStreamError({ reason: `Healthcheck failed`, cause: error })
    }).pipe(
      Effect.catchTag("RedisStreamError", (error) =>
        new SubscriberError.SubscriberError({ reason: `Healthcheck failed`, cause: error })),
      Effect.asVoid
    )
  })

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisStreamSubscriberOptions {
  uninterruptible?: boolean
  handlerTimeout?: Duration.DurationInput
  blockTimeout?: number
  count?: number
}

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  streamName: string,
  options: RedisStreamSubscriberOptions = {}
): Effect.Effect<
  RedisStreamSubscriber,
  RedisError.RedisConnectionError,
  RedisConnection.RedisConnection
> =>
  Effect.gen(function*() {
    const connection = yield* RedisConnection.RedisConnection

    const subscriber: RedisStreamSubscriber = {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(connection, streamName, options) as any,
      healthCheck: healthCheck(connection, streamName)
    }

    return subscriber
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (
  streamName: string,
  options: RedisStreamSubscriberOptions = {}
): Layer.Layer<
  RedisStreamSubscriber,
  RedisError.RedisConnectionError,
  RedisConnection.RedisConnection
> => Layer.effect(RedisStreamSubscriber, make(streamName, options))
