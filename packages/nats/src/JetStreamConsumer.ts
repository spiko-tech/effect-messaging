/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as utils from "./internal/utils.js"
import * as JetStreamMessage from "./JetStreamMessage.js"
import * as NATSError from "./NATSError.js"
import * as NATSQueuedIterator from "./NATSQueuedIterator.js"

const wrap = utils.wrap(NATSError.JetStreamConsumerError)
const wrapAsync = utils.wrapAsync(NATSError.JetStreamConsumerError)

/**
 * @category type ids
 * @since 0.1.0
 */
export const CloseTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Close")

/**
 * @category type ids
 * @since 0.1.0
 */
export type CloseTypeId = typeof CloseTypeId

/**
 * Represents closeable resources
 *
 * @category models
 * @since 0.1.0
 */
export interface Close {
  readonly [CloseTypeId]: CloseTypeId
  readonly close: Effect.Effect<void, NATSError.JetStreamConsumerError>
  readonly closed: Effect.Effect<void, NATSError.JetStreamConsumerError>
}

/** @internal */
export const makeClose = (closeable: JetStream.Close): Close => ({
  [CloseTypeId]: CloseTypeId,
  close: wrapAsync(() => closeable.close(), "Failed to close resource").pipe(
    Effect.flatMap((result) =>
      result instanceof Error
        ? Effect.fail(new NATSError.JetStreamConsumerError({ reason: "Failed to close resource", cause: result }))
        : Effect.void
    )
  ),
  closed: wrapAsync(() => closeable.closed(), "Failed to check closed status").pipe(
    Effect.flatMap((result) =>
      result instanceof Error
        ? Effect.fail(new NATSError.JetStreamConsumerError({ reason: "Resource closed with error", cause: result }))
        : Effect.void
    )
  )
})

/**
 * @category type ids
 * @since 0.1.0
 */
export const ConsumerMessagesTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ConsumerMessages")

/**
 * @category type ids
 * @since 0.1.0
 */
export type ConsumerMessagesTypeId = typeof ConsumerMessagesTypeId

/**
 * Represents consumer messages
 *
 * @category models
 * @since 0.1.0
 */
export interface ConsumerMessages extends
  Omit<
    NATSQueuedIterator.NATSQueuedIterator<JetStreamMessage.JetStreamMessage, NATSError.JetStreamConsumerError>,
    "iterator"
  >,
  Close
{
  readonly [ConsumerMessagesTypeId]: ConsumerMessagesTypeId
  readonly status: Effect.Effect<
    Stream.Stream<JetStream.ConsumerNotification, NATSError.JetStreamConsumerError>,
    NATSError.JetStreamConsumerError
  >

  /** @internal */
  readonly consumerMessages: JetStream.ConsumerMessages
}

/** @internal */
export const makeConsumerMessages = (consumerMessages: JetStream.ConsumerMessages): ConsumerMessages => {
  const qi = NATSQueuedIterator.make(NATSError.JetStreamConsumerError)(consumerMessages)
  const close = makeClose(consumerMessages)
  return {
    ...qi,
    ...close,
    [ConsumerMessagesTypeId]: ConsumerMessagesTypeId,
    stream: Stream.map(qi.stream, JetStreamMessage.make),
    status: wrap(
      () =>
        Stream.fromAsyncIterable(
          consumerMessages.status(),
          (error) =>
            new NATSError.JetStreamConsumerError({
              reason: "An error occurred in consumer status async iterable",
              cause: error
            })
        ),
      "Failed to get status stream"
    ),
    consumerMessages
  }
}

/**
 * @category type ids
 * @since 0.1.0
 */
export const ConsumerKindTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ConsumerKind")

/**
 * @category type ids
 * @since 0.1.0
 */
export type ConsumerKindTypeId = typeof ConsumerKindTypeId

/**
 * Represents consumer kind
 *
 * @category models
 * @since 0.1.0
 */
export interface ConsumerKind {
  readonly [ConsumerKindTypeId]: ConsumerKindTypeId
  readonly isPullConsumer: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
  readonly isPushConsumer: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
}

/**
 * @category type ids
 * @since 0.1.0
 */
export const ExportedConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ExportedConsumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type ExportedConsumerTypeId = typeof ExportedConsumerTypeId

/**
 * Represents an exported consumer
 *
 * @category models
 * @since 0.1.0
 */
export interface ExportedConsumer extends ConsumerKind {
  readonly [ExportedConsumerTypeId]: ExportedConsumerTypeId
  readonly next: (
    ...args: Parameters<JetStream.Consumer["next"]>
  ) => Effect.Effect<Option.Option<JetStreamMessage.JetStreamMessage>, NATSError.JetStreamConsumerError>
  readonly fetch: (
    ...args: Parameters<JetStream.Consumer["fetch"]>
  ) => Effect.Effect<ConsumerMessages, NATSError.JetStreamConsumerError>
  readonly consume: (
    ...args: Parameters<JetStream.Consumer["consume"]>
  ) => Effect.Effect<ConsumerMessages, NATSError.JetStreamConsumerError>
}

/**
 * @category type ids
 * @since 0.1.0
 */
export const InfoableConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/InfoableConsumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type InfoableConsumerTypeId = typeof InfoableConsumerTypeId

/**
 * Represents an infoable consumer
 *
 * @category models
 * @since 0.1.0
 */
export interface InfoableConsumer {
  readonly [InfoableConsumerTypeId]: InfoableConsumerTypeId
  readonly info: (
    ...args: Parameters<JetStream.Consumer["info"]>
  ) => Effect.Effect<JetStream.ConsumerInfo, NATSError.JetStreamConsumerError>
}

/**
 * @category type ids
 * @since 0.1.0
 */
export const DeleteableConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/DeleteableConsumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type DeleteableConsumerTypeId = typeof DeleteableConsumerTypeId

/**
 * Represents a deleteable consumer
 *
 * @category models
 * @since 0.1.0
 */
export interface DeleteableConsumer {
  readonly [DeleteableConsumerTypeId]: DeleteableConsumerTypeId
  readonly delete: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
}

/**
 * @category type ids
 * @since 0.1.0
 */
export const ConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Consumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type ConsumerTypeId = typeof ConsumerTypeId

/**
 * Represents a consumer
 *
 * @category models
 * @since 0.1.0
 */
export interface Consumer extends ExportedConsumer, InfoableConsumer, DeleteableConsumer {
  readonly [ConsumerTypeId]: ConsumerTypeId

  /** @internal */
  readonly consumer: JetStream.Consumer
}

/** @internal */
export const makeConsumer = (consumer: JetStream.Consumer): Consumer => ({
  [ConsumerTypeId]: ConsumerTypeId,
  [ExportedConsumerTypeId]: ExportedConsumerTypeId,
  [ConsumerKindTypeId]: ConsumerKindTypeId,
  [InfoableConsumerTypeId]: InfoableConsumerTypeId,
  [DeleteableConsumerTypeId]: DeleteableConsumerTypeId,
  isPullConsumer: wrap(() => consumer.isPullConsumer(), "Failed to check if consumer is pull consumer"),
  isPushConsumer: wrap(() => consumer.isPushConsumer(), "Failed to check if consumer is push consumer"),
  next: (...args) =>
    wrapAsync(() => consumer.next(...args), "Failed to get next message").pipe(
      Effect.map((msg) => Option.fromNullable(msg ? JetStreamMessage.make(msg) : null))
    ),
  fetch: (...args) =>
    wrapAsync(() => consumer.fetch(...args), "Failed to fetch messages").pipe(Effect.map(makeConsumerMessages)),
  consume: (...args) =>
    wrapAsync(() => consumer.consume(...args), "Failed to consume messages").pipe(Effect.map(makeConsumerMessages)),
  info: (...args) => wrapAsync(() => consumer.info(...args), "Failed to get consumer info"),
  delete: wrapAsync(() => consumer.delete(), "Failed to delete consumer"),
  consumer
})

/**
 * @category type ids
 * @since 0.1.0
 */
export const PushConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/PushConsumer")

/**
 * @category type ids
 * @since 0.1.0
 */
export type PushConsumerTypeId = typeof PushConsumerTypeId

/**
 * Represents a push consumer
 *
 * @category models
 * @since 0.1.0
 */
export interface PushConsumer extends InfoableConsumer, DeleteableConsumer, ConsumerKind {
  readonly [PushConsumerTypeId]: PushConsumerTypeId
  readonly consume: (
    ...args: Parameters<JetStream.PushConsumer["consume"]>
  ) => Effect.Effect<ConsumerMessages, NATSError.JetStreamConsumerError>

  /** @internal */
  readonly pushConsumer: JetStream.PushConsumer
}

/** @internal */
export const makePushConsumer = (pushConsumer: JetStream.PushConsumer): PushConsumer => ({
  [PushConsumerTypeId]: PushConsumerTypeId,
  [ConsumerKindTypeId]: ConsumerKindTypeId,
  [InfoableConsumerTypeId]: InfoableConsumerTypeId,
  [DeleteableConsumerTypeId]: DeleteableConsumerTypeId,
  isPullConsumer: wrap(() => pushConsumer.isPullConsumer(), "Failed to check if consumer is pull consumer"),
  isPushConsumer: wrap(() => pushConsumer.isPushConsumer(), "Failed to check if consumer is push consumer"),
  consume: (...args) =>
    wrapAsync(() => pushConsumer.consume(...args), "Failed to consume messages").pipe(Effect.map(makeConsumerMessages)),
  info: (...args) => wrapAsync(() => pushConsumer.info(...args), "Failed to get consumer info"),
  delete: wrapAsync(() => pushConsumer.delete(), "Failed to delete consumer"),
  pushConsumer
})

/**
 * @category type ids
 * @since 0.1.0
 */
export const ConsumersTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Consumers")

/**
 * @category type ids
 * @since 0.1.0
 */
export type ConsumersTypeId = typeof ConsumersTypeId

/**
 * Represents consumers API
 *
 * @category models
 * @since 0.1.0
 */
export interface Consumers {
  readonly [ConsumersTypeId]: ConsumersTypeId
  readonly get: (
    ...args: Parameters<JetStream.Consumers["get"]>
  ) => Effect.Effect<Consumer, NATSError.JetStreamConsumerError>
  readonly getConsumerFromInfo: (
    ...args: Parameters<JetStream.Consumers["getConsumerFromInfo"]>
  ) => Effect.Effect<Consumer, NATSError.JetStreamConsumerError>
  readonly getPushConsumer: (
    ...args: Parameters<JetStream.Consumers["getPushConsumer"]>
  ) => Effect.Effect<PushConsumer, NATSError.JetStreamConsumerError>
  readonly getBoundPushConsumer: (
    ...args: Parameters<JetStream.Consumers["getBoundPushConsumer"]>
  ) => Effect.Effect<PushConsumer, NATSError.JetStreamConsumerError>

  /** @internal */
  readonly consumers: JetStream.Consumers
}

/** @internal */
export const makeConsumers = (consumers: JetStream.Consumers): Consumers => ({
  [ConsumersTypeId]: ConsumersTypeId,
  get: (...args) => wrapAsync(() => consumers.get(...args), "Failed to get consumer").pipe(Effect.map(makeConsumer)),
  getConsumerFromInfo: (...args) =>
    wrap(() => (consumers.getConsumerFromInfo(...args)), "Failed to get consumer from info").pipe(
      Effect.map(makeConsumer)
    ),
  getPushConsumer: (...args) =>
    wrapAsync(() => consumers.getPushConsumer(...args), "Failed to get push consumer").pipe(
      Effect.map(makePushConsumer)
    ),
  getBoundPushConsumer: (...args) =>
    wrapAsync(() => consumers.getBoundPushConsumer(...args), "Failed to get bound push consumer").pipe(
      Effect.map(makePushConsumer)
    ),
  consumers
})
