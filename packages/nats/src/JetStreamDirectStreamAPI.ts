/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as utils from "./internal/utils.js"
import * as JetStreamStoredMessage from "./JetStreamStoredMessage.js"
import * as NATSError from "./NATSError.js"

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
  ) => Stream.Stream<JetStreamStoredMessage.JetStreamStoredMessage, NATSError.JetStreamDirectStreamAPIError, never>
  readonly getLastMessagesFor: (
    ...params: Parameters<JetStream.DirectStreamAPI["getLastMessagesFor"]>
  ) => Stream.Stream<JetStreamStoredMessage.JetStreamStoredMessage, NATSError.JetStreamDirectStreamAPIError, never>

  /** @internal */
  readonly direct: JetStream.DirectStreamAPI
}

/**
 * @category tags
 * @since 0.1.0
 */
export const JetStreamDirectStreamAPI = Context.GenericTag<JetStreamDirectStreamAPI>(
  "@effect-messaging/nats/JetStreamDirectStreamAPI"
)

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
      Effect.map((iterator) =>
        Stream.fromAsyncIterable(
          iterator,
          (error) =>
            new NATSError.JetStreamDirectStreamAPIError({
              reason: "An error occurred in getBatch async iterable",
              cause: error
            })
        )
      ),
      Stream.unwrap,
      Stream.map(JetStreamStoredMessage.make)
    ),
  getLastMessagesFor: (...params: Parameters<JetStream.DirectStreamAPI["getLastMessagesFor"]>) =>
    wrapAsync(() => direct.getLastMessagesFor(...params), "Failed to get last messages for subjects").pipe(
      Effect.map((iterator) =>
        Stream.fromAsyncIterable(
          iterator,
          (error) =>
            new NATSError.JetStreamDirectStreamAPIError({
              reason: "An error occurred in getLastMessagesFor async iterable",
              cause: error
            })
        )
      ),
      Stream.unwrap,
      Stream.map(JetStreamStoredMessage.make)
    ),

  direct
})
