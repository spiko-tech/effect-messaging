/**
 * @since 0.1.0
 */
import * as Consumer from "@effect-messaging/core/Consumer"
import type * as ConsumerApp from "@effect-messaging/core/ConsumerApp"
import * as ConsumerError from "@effect-messaging/core/ConsumerError"
import type * as NATSCore from "@nats-io/nats-core"
import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import type * as JetStreamConsumerMessages from "./JetStreamConsumerMessages.js"
import type * as JetStreamConsumerResponse from "./JetStreamConsumerResponse.js"
import * as JetStreamMessage from "./JetStreamMessage.js"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"
import * as NATSHeaders from "./NATSHeaders.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamConsumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.7.0
 */
export type JetStreamConsumerApp<E, R> = ConsumerApp.ConsumerApp<
  JetStreamConsumerResponse.JetStreamConsumerResponse,
  JetStreamMessage.JetStreamMessage,
  E,
  R
>

/**
 * @category models
 * @since 0.1.0
 */
export interface JetStreamConsumer
  extends Consumer.Consumer<JetStreamConsumerResponse.JetStreamConsumerResponse, JetStreamMessage.JetStreamMessage>
{
  readonly [TypeId]: TypeId
}

/**
 * @category models
 * @since 0.1.0
 */
export interface JetStreamConsumerOptions {
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
const ATTR_MESSAGING_NATS_STREAM = "messaging.nats.stream" as const
const ATTR_MESSAGING_NATS_CONSUMER = "messaging.nats.consumer" as const
const ATTR_MESSAGING_NATS_SEQUENCE_STREAM = "messaging.nats.sequence.stream" as const
const ATTR_MESSAGING_NATS_SEQUENCE_CONSUMER = "messaging.nats.sequence.consumer" as const

/** @internal */
const subscribe = (
  consumerMessages: JetStreamConsumerMessages.ConsumerMessages,
  connectionInfo: NATSCore.ServerInfo,
  options: JetStreamConsumerOptions
) =>
<E, R>(
  app: JetStreamConsumerApp<E, R>
): Effect.Effect<void, ConsumerError.ConsumerError, Exclude<R, JetStreamMessage.JetStreamMessage>> =>
  consumerMessages.stream.pipe(
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
              [ATTR_MESSAGING_MESSAGE_ID]: message.seq,
              [ATTR_MESSAGING_NATS_STREAM]: message.info.stream,
              [ATTR_MESSAGING_NATS_CONSUMER]: message.info.consumer,
              [ATTR_MESSAGING_NATS_SEQUENCE_STREAM]: message.info.streamSequence,
              [ATTR_MESSAGING_NATS_SEQUENCE_CONSUMER]: message.info.deliverySequence
            }
          },
          (span) =>
            Effect.gen(function*() {
              yield* Effect.logDebug(`nats.consume ${message.subject}`)
              return yield* app.pipe(
                options.handlerTimeout
                  ? Effect.timeoutFail({
                    duration: options.handlerTimeout,
                    onTimeout: () => new ConsumerError.ConsumerError({ reason: "JetStreamConsumer: handler timed out" })
                  })
                  : Function.identity
              )
            }).pipe(
              Effect.provide(JetStreamMessage.layer(message)),
              Effect.matchCauseEffect(
                {
                  onSuccess: (res) =>
                    Match.valueTags(res, {
                      Ack: () =>
                        Effect.gen(function*() {
                          span.attribute(ATTR_MESSAGING_OPERATION_NAME, "ack")
                          yield* message.ack
                        }),
                      Nak: (r) =>
                        Effect.gen(function*() {
                          span.attribute(ATTR_MESSAGING_OPERATION_NAME, "nak")
                          yield* message.nak(r.millis)
                        }),
                      Term: (r) =>
                        Effect.gen(function*() {
                          span.attribute(ATTR_MESSAGING_OPERATION_NAME, "term")
                          yield* message.term(r.reason)
                        })
                    }),
                  onFailure: (cause) =>
                    Effect.gen(function*() {
                      yield* Effect.logError(Cause.pretty(cause))
                      span.attribute(ATTR_MESSAGING_OPERATION_NAME, "nak")
                      span.attribute(
                        "error.type",
                        Cause.squashWith(cause, (_) =>
                          Predicate.hasProperty(_, "tag") ? _.tag : _ instanceof Error ? _.name : `${_}`)
                      )
                      span.attribute("error.stack", Cause.pretty(cause))
                      span.attribute(
                        "error.message",
                        Cause.squashWith(cause, (_) =>
                          Predicate.hasProperty(_, "reason") ? _.reason : _ instanceof Error ? _.message : `${_}`)
                      )
                      yield* message.nak()
                    })
                }
              ),
              options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
              Effect.withParentSpan(span)
            )
        )
      )
    ),
    Effect.mapError((error) =>
      new ConsumerError.ConsumerError({ reason: "JetStreamConsumer failed to subscribe", cause: error })
    )
  )

/** @internal */
const healthCheck = (
  consumer: JetStreamConsumerMessages.InfoableConsumer
): Effect.Effect<void, ConsumerError.ConsumerError, never> =>
  consumer.info().pipe(
    Effect.catchTag("JetStreamConsumerError", (error) =>
      new ConsumerError.ConsumerError({ reason: "Healthcheck failed", cause: error })),
    Effect.asVoid
  )

/**
 * Create a JetStreamConsumer from an existing ConsumerMessages and Consumer.
 *
 * This constructor is useful when you want to control the consumer lifecycle
 * separately from the consumer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromConsumerMessages = (
  consumerMessages: JetStreamConsumerMessages.ConsumerMessages,
  natsConsumer: JetStreamConsumerMessages.InfoableConsumer,
  options: JetStreamConsumerOptions = {}
): Effect.Effect<
  JetStreamConsumer,
  NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const connectionInfo = yield* Option.match(connection.info, {
      onNone: () => Effect.fail(new NATSError.NATSConnectionError({ reason: "Connection info not available" })),
      onSome: Effect.succeed
    })

    const consumer: JetStreamConsumer = {
      [TypeId]: TypeId,
      [Consumer.TypeId]: Consumer.TypeId,
      serve: subscribe(consumerMessages, connectionInfo, options),
      healthCheck: healthCheck(natsConsumer)
    }

    return consumer
  })

/**
 * Create a JetStreamConsumer from an existing Consumer.
 *
 * This is a convenience constructor that internally calls `consume()` on the consumer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromConsumer = (
  natsConsumer: JetStreamConsumerMessages.Consumer,
  options: JetStreamConsumerOptions = {},
  consumeOptions?: Parameters<JetStreamConsumerMessages.Consumer["consume"]>[0]
): Effect.Effect<
  JetStreamConsumer,
  NATSError.JetStreamConsumerError | NATSError.NATSConnectionError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const consumerMessages = yield* natsConsumer.consume(consumeOptions)
    return yield* fromConsumerMessages(consumerMessages, natsConsumer, options)
  })
