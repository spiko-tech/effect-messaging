/**
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as SubscriberOTel from "@effect-messaging/core/SubscriberOTel"
import * as SubscriberRunner from "@effect-messaging/core/SubscriberRunner"
import type * as NATSCore from "@nats-io/nats-core"
import * as Effect from "effect/Effect"

import * as Option from "effect/Option"
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
export interface NATSSubscriberOptions extends SubscriberRunner.SubscriberRunnerOptions {}

/** @internal */
const subscribe = (
  subscription: NATSSubscription.NATSSubscription,
  connectionInfo: NATSCore.ServerInfo,
  options: NATSSubscriberOptions
) =>
<E, R>(
  handler: Effect.Effect<void, E, R | NATSMessage.NATSMessage>
): Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, NATSMessage.NATSMessage>> =>
  SubscriberRunner.runStream(subscription.stream, {
    name: "NATSSubscriber",
    spanName: (message) => `nats.consume ${message.subject}`,
    parentSpan: (message) => Option.getOrUndefined(NATSHeaders.decodeTraceContextOptional(message.headers)),
    spanAttributes: (message) => ({
      [SubscriberOTel.SpanAttributes.SERVER_ADDRESS]: connectionInfo.host,
      [SubscriberOTel.SpanAttributes.SERVER_PORT]: connectionInfo.port,
      [SubscriberOTel.SpanAttributes.MESSAGING_SYSTEM]: "nats",
      [SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_TYPE]: "receive",
      [SubscriberOTel.SpanAttributes.MESSAGING_DESTINATION_NAME]: message.subject,
      [SubscriberOTel.SpanAttributes.MESSAGING_MESSAGE_ID]: message.sid
    }),
    handler: (message) => handler.pipe(Effect.provide(NATSMessage.layer(message))),
    options,
    onSuccess: (_message, span) => () =>
      Effect.sync(() => {
        span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "process")
      }),
    onError: (_message, span) => () =>
      Effect.sync(() => {
        span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "error")
      })
  })

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
