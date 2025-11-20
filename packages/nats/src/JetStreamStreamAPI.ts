/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as utils from "./internal/utils.js"
import * as JetStreamLister from "./JetStreamLister.js"
import * as JetStreamStoredMessage from "./JetStreamStoredMessage.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStreamAPI")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Stream API
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamStreamAPI {
  readonly [TypeId]: TypeId
  readonly info: (
    ...params: Parameters<JetStream.StreamAPI["info"]>
  ) => Effect.Effect<JetStream.StreamInfo, NATSError.JetStreamStreamAPIError, never>
  readonly add: (
    ...params: Parameters<JetStream.StreamAPI["add"]>
  ) => Effect.Effect<JetStream.StreamInfo, NATSError.JetStreamStreamAPIError, never>
  readonly update: (
    ...params: Parameters<JetStream.StreamAPI["update"]>
  ) => Effect.Effect<JetStream.StreamInfo, NATSError.JetStreamStreamAPIError, never>
  readonly purge: (
    ...params: Parameters<JetStream.StreamAPI["purge"]>
  ) => Effect.Effect<JetStream.PurgeResponse, NATSError.JetStreamStreamAPIError, never>
  readonly delete: (
    ...params: Parameters<JetStream.StreamAPI["delete"]>
  ) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError, never>
  readonly list: (
    ...params: Parameters<JetStream.StreamAPI["list"]>
  ) => Effect.Effect<
    JetStreamLister.JetStreamLister<JetStream.StreamInfo, NATSError.JetStreamStreamAPIError>,
    NATSError.JetStreamStreamAPIError,
    never
  >
  readonly deleteMessage: (
    ...params: Parameters<JetStream.StreamAPI["deleteMessage"]>
  ) => Effect.Effect<boolean, NATSError.JetStreamStreamAPIError, never>
  readonly getMessage: (
    ...params: Parameters<JetStream.StreamAPI["getMessage"]>
  ) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamStreamAPIError,
    never
  >
  readonly find: (
    ...params: Parameters<JetStream.StreamAPI["find"]>
  ) => Effect.Effect<string, NATSError.JetStreamStreamAPIError, never>
  readonly names: (
    ...params: Parameters<JetStream.StreamAPI["names"]>
  ) => Effect.Effect<
    JetStreamLister.JetStreamLister<string, NATSError.JetStreamStreamAPIError>,
    NATSError.JetStreamStreamAPIError,
    never
  >

  /** @internal */
  readonly streams: JetStream.StreamAPI
}

const wrap = utils.wrap(NATSError.JetStreamStreamAPIError)
const wrapAsync = utils.wrapAsync(NATSError.JetStreamStreamAPIError)

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (streams: JetStream.StreamAPI): JetStreamStreamAPI => ({
  [TypeId]: TypeId,
  info: (...params: Parameters<JetStream.StreamAPI["info"]>) =>
    wrapAsync(() => streams.info(...params), "Failed to get stream info"),
  add: (...params: Parameters<JetStream.StreamAPI["add"]>) =>
    wrapAsync(() => streams.add(...params), "Failed to add stream"),
  update: (...params: Parameters<JetStream.StreamAPI["update"]>) =>
    wrapAsync(() => streams.update(...params), "Failed to update stream"),
  purge: (...params: Parameters<JetStream.StreamAPI["purge"]>) =>
    wrapAsync(() => streams.purge(...params), "Failed to purge stream"),
  delete: (...params: Parameters<JetStream.StreamAPI["delete"]>) =>
    wrapAsync(() => streams.delete(...params), "Failed to delete stream"),
  list: (...params: Parameters<JetStream.StreamAPI["list"]>) =>
    wrap(() => streams.list(...params), "Failed to list streams").pipe(
      Effect.map(JetStreamLister.make(NATSError.JetStreamStreamAPIError))
    ),
  deleteMessage: (...params: Parameters<JetStream.StreamAPI["deleteMessage"]>) =>
    wrapAsync(() => streams.deleteMessage(...params), "Failed to delete message"),
  getMessage: (...params: Parameters<JetStream.StreamAPI["getMessage"]>) =>
    wrapAsync(() => streams.getMessage(...params), "Failed to get message").pipe(
      Effect.map(Option.fromNullable),
      Effect.map(Option.map(JetStreamStoredMessage.make))
    ),
  find: (...params: Parameters<JetStream.StreamAPI["find"]>) =>
    wrapAsync(() => streams.find(...params), "Failed to find stream"),
  names: (...params: Parameters<JetStream.StreamAPI["names"]>) =>
    wrap(() => streams.names(...params), "Failed to list stream names").pipe(
      Effect.map(JetStreamLister.make(NATSError.JetStreamStreamAPIError))
    ),

  streams
})
