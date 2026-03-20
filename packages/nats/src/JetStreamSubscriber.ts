/**
 * @since 0.1.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import type * as SubscriberApp from "@effect-messaging/core/SubscriberApp"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as SubscriberOTel from "@effect-messaging/core/SubscriberOTel"
import * as SubscriberRunner from "@effect-messaging/core/SubscriberRunner"
import type * as NATSCore from "@nats-io/nats-core"
import * as Effect from "effect/Effect"

import * as Match from "effect/Match"
import * as Option from "effect/Option"
import type * as JetStreamConsumer from "./JetStreamConsumer.js"
import * as JetStreamMessage from "./JetStreamMessage.js"
import type * as JetStreamSubscriberResponse from "./JetStreamSubscriberResponse.js"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"
import * as NATSHeaders from "./NATSHeaders.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamSubscriber")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.7.0
 */
export type JetStreamSubscriberApp<E, R> = SubscriberApp.SubscriberApp<
  JetStreamSubscriberResponse.JetStreamSubscriberResponse,
  JetStreamMessage.JetStreamMessage,
  E,
  R
>

/**
 * @category models
 * @since 0.1.0
 */
export interface JetStreamSubscriber
  extends
    Subscriber.Subscriber<JetStreamSubscriberResponse.JetStreamSubscriberResponse, JetStreamMessage.JetStreamMessage>
{
  readonly [TypeId]: TypeId
}

/**
 * @category models
 * @since 0.1.0
 */
export interface JetStreamSubscriberOptions extends SubscriberRunner.SubscriberRunnerOptions {}

const ATTR_MESSAGING_NATS_STREAM = "messaging.nats.stream" as const
const ATTR_MESSAGING_NATS_CONSUMER = "messaging.nats.consumer" as const
const ATTR_MESSAGING_NATS_SEQUENCE_STREAM = "messaging.nats.sequence.stream" as const
const ATTR_MESSAGING_NATS_SEQUENCE_CONSUMER = "messaging.nats.sequence.consumer" as const

/** @internal */
const subscribe = (
  consumerMessages: JetStreamConsumer.ConsumerMessages,
  connectionInfo: NATSCore.ServerInfo,
  options: JetStreamSubscriberOptions
) =>
<E, R>(
  app: JetStreamSubscriberApp<E, R>
): Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, JetStreamMessage.JetStreamMessage>> =>
  SubscriberRunner.runStream(consumerMessages.stream, {
    name: "JetStreamSubscriber",
    spanName: (message) => `nats.consume ${message.subject}`,
    parentSpan: (message) => Option.getOrUndefined(NATSHeaders.decodeTraceContextOptional(message.headers)),
    spanAttributes: (message) => ({
      [SubscriberOTel.SpanAttributes.SERVER_ADDRESS]: connectionInfo.host,
      [SubscriberOTel.SpanAttributes.SERVER_PORT]: connectionInfo.port,
      [SubscriberOTel.SpanAttributes.MESSAGING_SYSTEM]: "nats",
      [SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_TYPE]: "receive",
      [SubscriberOTel.SpanAttributes.MESSAGING_DESTINATION_NAME]: message.subject,
      [SubscriberOTel.SpanAttributes.MESSAGING_MESSAGE_ID]: message.seq,
      [ATTR_MESSAGING_NATS_STREAM]: message.info.stream,
      [ATTR_MESSAGING_NATS_CONSUMER]: message.info.consumer,
      [ATTR_MESSAGING_NATS_SEQUENCE_STREAM]: message.info.streamSequence,
      [ATTR_MESSAGING_NATS_SEQUENCE_CONSUMER]: message.info.deliverySequence
    }),
    handler: (message) => app.pipe(Effect.provide(JetStreamMessage.layer(message))),
    options,
    onSuccess: (_message, span) => (response) =>
      Match.valueTags(response, {
        Ack: () =>
          Effect.gen(function*() {
            span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "ack")
            yield* _message.ack
          }),
        Nak: (r) =>
          Effect.gen(function*() {
            span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "nak")
            yield* _message.nak(r.millis)
          }),
        Term: (r) =>
          Effect.gen(function*() {
            span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "term")
            yield* _message.term(r.reason)
          })
      }),
    onError: (_message, span) => () =>
      Effect.gen(function*() {
        span.attribute(SubscriberOTel.SpanAttributes.MESSAGING_OPERATION_NAME, "nak")
        yield* _message.nak()
      })
  })

/** @internal */
const healthCheck = (
  consumer: JetStreamConsumer.InfoableConsumer
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  consumer.info().pipe(
    Effect.catchTag("JetStreamConsumerError", (error) =>
      new SubscriberError.SubscriberError({ reason: "Healthcheck failed", cause: error })),
    Effect.asVoid
  )

/**
 * Create a JetStreamSubscriber from an existing ConsumerMessages and Consumer.
 *
 * This constructor is useful when you want to control the consumer lifecycle
 * separately from the subscriber.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromConsumerMessages = (
  consumerMessages: JetStreamConsumer.ConsumerMessages,
  consumer: JetStreamConsumer.InfoableConsumer,
  options: JetStreamSubscriberOptions = {}
): Effect.Effect<
  JetStreamSubscriber,
  NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const connectionInfo = yield* Option.match(connection.info, {
      onNone: () => Effect.fail(new NATSError.NATSConnectionError({ reason: "Connection info not available" })),
      onSome: Effect.succeed
    })

    const subscriber: JetStreamSubscriber = {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(consumerMessages, connectionInfo, options),
      healthCheck: healthCheck(consumer)
    }

    return subscriber
  })

/**
 * Create a JetStreamSubscriber from an existing Consumer.
 *
 * This is a convenience constructor that internally calls `consume()` on the consumer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromConsumer = (
  consumer: JetStreamConsumer.Consumer,
  options: JetStreamSubscriberOptions = {},
  consumeOptions?: Parameters<JetStreamConsumer.Consumer["consume"]>[0]
): Effect.Effect<
  JetStreamSubscriber,
  NATSError.JetStreamConsumerError | NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const consumerMessages = yield* consumer.consume(consumeOptions)
    return yield* fromConsumerMessages(consumerMessages, consumer, options)
  })
