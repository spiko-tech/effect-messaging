/**
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import type * as NATSCore from "@nats-io/nats-core"
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"
import * as NATSHeaders from "./NATSHeaders.js"
import * as NATSMessage from "./NATSMessage.js"
import type * as NATSSubscription from "./NATSSubscription.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSSubscriber")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface NATSSubscriber extends Subscriber.Subscriber<void, NATSMessage.NATSMessage> {
  readonly [TypeId]: TypeId
}

/**
 * @category models
 * @since 0.3.0
 */
export interface NATSSubscriberOptions {
  uninterruptible?: boolean
  handlerTimeout?: Duration.DurationInput
}

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const
const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id" as const

/** @internal */
const subscribe = (
  subscription: NATSSubscription.NATSSubscription,
  connectionInfo: NATSCore.ServerInfo,
  options: NATSSubscriberOptions
) =>
<E, R>(
  handler: Effect.Effect<void, E, R | NATSMessage.NATSMessage>
): Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, NATSMessage.NATSMessage>> =>
  subscription.stream.pipe(
    Stream.runForEach((message) =>
      Effect.fork(
        Effect.useSpan(
          `nats.consume ${message.subject}`,
          {
            parent: Option.getOrUndefined(NATSHeaders.decodeTraceContextOptional(message.headers)),
            kind: "consumer",
            captureStackTrace: false,
            attributes: {
              [ATTR_SERVER_ADDRESS]: connectionInfo.host,
              [ATTR_SERVER_PORT]: connectionInfo.port,
              [ATTR_MESSAGING_SYSTEM]: "nats",
              [ATTR_MESSAGING_OPERATION_TYPE]: "receive",
              [ATTR_MESSAGING_DESTINATION_NAME]: message.subject,
              [ATTR_MESSAGING_MESSAGE_ID]: message.sid
            }
          },
          (span) =>
            Effect.gen(function*() {
              yield* Effect.logDebug(`nats.consume ${message.subject}`)
              yield* handler.pipe(
                options.handlerTimeout
                  ? Effect.timeoutFail({
                    duration: options.handlerTimeout,
                    onTimeout: () =>
                      new SubscriberError.SubscriberError({ reason: "NATSSubscriber: handler timed out" })
                  })
                  : Function.identity
              )
              span.attribute(ATTR_MESSAGING_OPERATION_NAME, "process")
            }).pipe(
              Effect.provide(NATSMessage.layer(message)),
              Effect.tapErrorCause((cause) =>
                Effect.gen(function*() {
                  // Log the error - NATS Core has no ack/nak mechanism, so we just log and continue
                  yield* Effect.logError(Cause.pretty(cause))
                  span.attribute(ATTR_MESSAGING_OPERATION_NAME, "error")
                  span.attribute(
                    "error.type",
                    String(Cause.squashWith(
                      cause,
                      (_) => Predicate.hasProperty(_, "_tag") ? _._tag : _ instanceof Error ? _.name : `${_}`
                    ))
                  )
                  span.attribute("error.stack", Cause.pretty(cause))
                  span.attribute(
                    "error.message",
                    String(Cause.squashWith(
                      cause,
                      (_) => Predicate.hasProperty(_, "reason") ? _.reason : _ instanceof Error ? _.message : `${_}`
                    ))
                  )
                })
              ),
              options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
              Effect.withParentSpan(span)
            )
        )
      )
    ),
    Effect.mapError((error) =>
      new SubscriberError.SubscriberError({ reason: "NATSSubscriber failed to subscribe", cause: error })
    )
  )

/** @internal */
const healthCheck = (
  subscription: NATSSubscription.NATSSubscription
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  subscription.isClosed.pipe(
    Effect.flatMap((isClosed) =>
      isClosed
        ? Effect.fail(new SubscriberError.SubscriberError({ reason: "Subscription is closed" }))
        : Effect.void
    ),
    Effect.catchTag("NATSSubscriptionError", (error) =>
      new SubscriberError.SubscriberError({ reason: "Healthcheck failed", cause: error }))
  )

/**
 * Create a NATSSubscriber from an existing NATSSubscription.
 *
 * Note: NATS Core subscriptions are fire-and-forget. Messages are not persisted
 * and there is no acknowledgment mechanism. If the handler fails or times out,
 * the message is lost.
 *
 * @category constructors
 * @since 0.3.0
 */
export const fromSubscription = (
  subscription: NATSSubscription.NATSSubscription,
  options: NATSSubscriberOptions = {}
): Effect.Effect<
  NATSSubscriber,
  NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const connectionInfo = yield* Option.match(connection.info, {
      onNone: () => Effect.fail(new NATSError.NATSConnectionError({ reason: "Connection info not available" })),
      onSome: Effect.succeed
    })

    const subscriber: NATSSubscriber = {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(subscription, connectionInfo, options),
      healthCheck: healthCheck(subscription)
    }

    return subscriber
  })

/**
 * Create a NATSSubscriber by subscribing to a subject.
 *
 * This is a convenience constructor that internally calls `subscribe()` on the connection.
 *
 * Note: NATS Core subscriptions are fire-and-forget. Messages are not persisted
 * and there is no acknowledgment mechanism. If the handler fails or times out,
 * the message is lost.
 *
 * @category constructors
 * @since 0.3.0
 */
export const make = (
  subject: string,
  subscriptionOptions?: NATSCore.SubscriptionOptions,
  options: NATSSubscriberOptions = {}
): Effect.Effect<
  NATSSubscriber,
  NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const subscription = yield* connection.subscribe(subject, subscriptionOptions)
    return yield* fromSubscription(subscription, options)
  })
