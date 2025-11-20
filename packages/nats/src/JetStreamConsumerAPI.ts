/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as utils from "./internal/utils.js"
import * as JetStreamLister from "./JetStreamLister.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamConsumerAPI")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Consumer API
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamConsumerAPI {
  readonly [TypeId]: TypeId
  readonly add: (
    ...params: Parameters<JetStream.ConsumerAPI["add"]>
  ) => Effect.Effect<JetStream.ConsumerInfo, NATSError.JetStreamConsumerAPIError, never>
  readonly update: (
    ...params: Parameters<JetStream.ConsumerAPI["update"]>
  ) => Effect.Effect<JetStream.ConsumerInfo, NATSError.JetStreamConsumerAPIError, never>
  readonly info: (
    ...params: Parameters<JetStream.ConsumerAPI["info"]>
  ) => Effect.Effect<JetStream.ConsumerInfo, NATSError.JetStreamConsumerAPIError, never>
  readonly delete: (
    ...params: Parameters<JetStream.ConsumerAPI["delete"]>
  ) => Effect.Effect<boolean, NATSError.JetStreamConsumerAPIError, never>
  readonly list: (
    ...params: Parameters<JetStream.ConsumerAPI["list"]>
  ) => Effect.Effect<
    JetStreamLister.JetStreamLister<JetStream.ConsumerInfo, NATSError.JetStreamConsumerAPIError>,
    NATSError.JetStreamConsumerAPIError,
    never
  >
  readonly pause: (
    ...params: Parameters<JetStream.ConsumerAPI["pause"]>
  ) => Effect.Effect<
    {
      paused: boolean
      pause_until?: string
    },
    NATSError.JetStreamConsumerAPIError,
    never
  >
  readonly resume: (
    ...params: Parameters<JetStream.ConsumerAPI["resume"]>
  ) => Effect.Effect<
    {
      paused: boolean
      pause_until?: string
    },
    NATSError.JetStreamConsumerAPIError,
    never
  >
  readonly unpin: (
    ...params: Parameters<JetStream.ConsumerAPI["unpin"]>
  ) => Effect.Effect<void, NATSError.JetStreamConsumerAPIError, never>

  /** @internal */
  readonly consumers: JetStream.ConsumerAPI
}

const wrap = utils.wrap(NATSError.JetStreamConsumerAPIError)
const wrapAsync = utils.wrapAsync(NATSError.JetStreamConsumerAPIError)

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (consumerAPI: JetStream.ConsumerAPI): JetStreamConsumerAPI => ({
  [TypeId]: TypeId,
  add: (...params: Parameters<JetStream.ConsumerAPI["add"]>) =>
    wrapAsync(() => consumerAPI.add(...params), "Failed to add consumer"),
  update: (...params: Parameters<JetStream.ConsumerAPI["update"]>) =>
    wrapAsync(() => consumerAPI.update(...params), "Failed to update consumer"),
  info: (...params: Parameters<JetStream.ConsumerAPI["info"]>) =>
    wrapAsync(() => consumerAPI.info(...params), "Failed to get consumer info"),
  delete: (...params: Parameters<JetStream.ConsumerAPI["delete"]>) =>
    wrapAsync(() => consumerAPI.delete(...params), "Failed to delete consumer"),
  list: (...params: Parameters<JetStream.ConsumerAPI["list"]>) =>
    wrap(() => consumerAPI.list(...params), "Failed to list consumers").pipe(
      Effect.map(JetStreamLister.make(NATSError.JetStreamConsumerAPIError))
    ),
  pause: (...params: Parameters<JetStream.ConsumerAPI["pause"]>) =>
    wrapAsync(() => consumerAPI.pause(...params), "Failed to pause consumer"),
  resume: (...params: Parameters<JetStream.ConsumerAPI["resume"]>) =>
    wrapAsync(() => consumerAPI.resume(...params), "Failed to resume consumer"),
  unpin: (...params: Parameters<JetStream.ConsumerAPI["unpin"]>) =>
    wrapAsync(() => consumerAPI.unpin(...params), "Failed to unpin consumer"),

  consumers: consumerAPI
})
