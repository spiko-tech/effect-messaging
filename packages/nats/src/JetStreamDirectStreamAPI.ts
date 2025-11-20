/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as utils from "./internal/utils.js"
import * as JetStreamStoredMessage from "./JetStreamStoredMessage.js"
import * as NATSError from "./NATSError.js"
import * as NATSQueuedIterator from "./NATSQueuedIterator.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamDirectStreamAPI")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Direct Stream API
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamDirectStreamAPI {
  readonly [TypeId]: TypeId
  readonly getMessage: (
    ...params: Parameters<JetStream.DirectStreamAPI["getMessage"]>
  ) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamDirectStreamAPIError,
    never
  >
  readonly getBatch: (
    ...params: Parameters<JetStream.DirectStreamAPI["getBatch"]>
  ) => Effect.Effect<
    NATSQueuedIterator.NATSQueuedIterator<JetStream.StoredMsg, NATSError.JetStreamDirectStreamAPIError>,
    NATSError.JetStreamDirectStreamAPIError,
    never
  >
  readonly getLastMessagesFor: (
    ...params: Parameters<JetStream.DirectStreamAPI["getLastMessagesFor"]>
  ) => Effect.Effect<
    NATSQueuedIterator.NATSQueuedIterator<JetStream.StoredMsg, NATSError.JetStreamDirectStreamAPIError>,
    NATSError.JetStreamDirectStreamAPIError,
    never
  >

  /** @internal */
  readonly direct: JetStream.DirectStreamAPI
}

const wrapAsync = utils.wrapAsync(NATSError.JetStreamDirectStreamAPIError)

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (direct: JetStream.DirectStreamAPI): JetStreamDirectStreamAPI => ({
  [TypeId]: TypeId,
  getMessage: (...params: Parameters<JetStream.DirectStreamAPI["getMessage"]>) =>
    wrapAsync(() => direct.getMessage(...params), "Failed to get message").pipe(
      Effect.map(Option.fromNullable),
      Effect.map(Option.map(JetStreamStoredMessage.make))
    ),
  getBatch: (...params: Parameters<JetStream.DirectStreamAPI["getBatch"]>) =>
    wrapAsync(() => direct.getBatch(...params), "Failed to get batch").pipe(
      Effect.map(NATSQueuedIterator.make(NATSError.JetStreamDirectStreamAPIError))
    ),
  getLastMessagesFor: (...params: Parameters<JetStream.DirectStreamAPI["getLastMessagesFor"]>) =>
    wrapAsync(() => direct.getLastMessagesFor(...params), "Failed to get last messages for subjects").pipe(
      Effect.map(NATSQueuedIterator.make(NATSError.JetStreamDirectStreamAPIError))
    ),

  direct
})
