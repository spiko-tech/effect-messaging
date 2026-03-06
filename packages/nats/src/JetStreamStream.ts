/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as utils from "./internal/utils.js"
import * as JetStreamConsumerMessages from "./JetStreamConsumerMessages.js"
import * as JetStreamStoredMessage from "./JetStreamStoredMessage.js"
import * as NATSError from "./NATSError.js"

const wrapAsync = utils.wrapAsync(NATSError.JetStreamStreamError)

/**
 * @category type ids
 * @since 0.1.0
 */
export const JetStreamStreamTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStream")

/**
 * @category type ids
 * @since 0.1.0
 */
export type JetStreamStreamTypeId = typeof JetStreamStreamTypeId

/**
 * Represents a JetStream stream
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamStream {
  readonly [JetStreamStreamTypeId]: JetStreamStreamTypeId
  readonly name: string
  readonly info: (
    ...args: Parameters<JetStream.Stream["info"]>
  ) => Effect.Effect<JetStream.StreamInfo, NATSError.JetStreamStreamError>
  readonly getMessage: (
    ...args: Parameters<JetStream.Stream["getMessage"]>
  ) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamStreamError
  >
  readonly deleteMessage: (
    ...args: Parameters<JetStream.Stream["deleteMessage"]>
  ) => Effect.Effect<boolean, NATSError.JetStreamStreamError>
  readonly alternates: Effect.Effect<Array<JetStream.StreamAlternate>, NATSError.JetStreamStreamError>
  readonly best: Effect.Effect<JetStreamStream, NATSError.JetStreamStreamError>
  readonly getConsumer: (
    ...args: Parameters<JetStream.Stream["getConsumer"]>
  ) => Effect.Effect<JetStreamConsumerMessages.Consumer, NATSError.JetStreamStreamError>

  /** @internal */
  readonly stream: JetStream.Stream
}

/** @internal */
export const makeJetStreamStream = (stream: JetStream.Stream): JetStreamStream => ({
  [JetStreamStreamTypeId]: JetStreamStreamTypeId,
  name: stream.name,
  info: (...args) => wrapAsync(() => stream.info(...args), "Failed to get stream info"),
  getMessage: (...args) =>
    wrapAsync(() => stream.getMessage(...args), "Failed to get message").pipe(
      Effect.map(Option.fromNullable),
      Effect.map(Option.map(JetStreamStoredMessage.make))
    ),
  deleteMessage: (...args) => wrapAsync(() => stream.deleteMessage(...args), "Failed to delete message"),
  alternates: wrapAsync(() => stream.alternates(), "Failed to get stream alternates"),
  best: wrapAsync(() => stream.best(), "Failed to get best stream").pipe(Effect.map(makeJetStreamStream)),
  getConsumer: (...args) =>
    wrapAsync(() => stream.getConsumer(...args), "Failed to get consumer").pipe(
      Effect.map(JetStreamConsumerMessages.makeConsumer)
    ),
  stream
})

/**
 * @category type ids
 * @since 0.1.0
 */
export const JetStreamStreamsTypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStreams")

/**
 * @category type ids
 * @since 0.1.0
 */
export type JetStreamStreamsTypeId = typeof JetStreamStreamsTypeId

/**
 * Represents streams API
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamStreams {
  readonly [JetStreamStreamsTypeId]: JetStreamStreamsTypeId
  readonly get: (
    ...args: Parameters<JetStream.Streams["get"]>
  ) => Effect.Effect<JetStreamStream, NATSError.JetStreamStreamError>

  /** @internal */
  readonly streams: JetStream.Streams
}

/** @internal */
export const makeJetStreamStreams = (streams: JetStream.Streams): JetStreamStreams => ({
  [JetStreamStreamsTypeId]: JetStreamStreamsTypeId,
  get: (...args) => wrapAsync(() => streams.get(...args), "Failed to get stream").pipe(Effect.map(makeJetStreamStream)),
  streams
})
