/**
 * @since 0.1.0
 */
import * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as utils from "./internal/utils.js"
import * as JetStreamConsumerAPI from "./JetStreamConsumerAPI.js"
import * as JetStreamDirectStreamAPI from "./JetStreamDirectStreamAPI.js"
import * as JetStreamStreamAPI from "./JetStreamStreamAPI.js"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamManager")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Manager
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamManager {
  readonly [TypeId]: TypeId
  readonly accountInfo: Effect.Effect<JetStream.JetStreamAccountStats, NATSError.JetStreamManagerError, never>
  readonly advisoryStream: Stream.Stream<JetStream.Advisory, NATSError.JetStreamManagerError, never>
  readonly options: Effect.Effect<JetStream.JetStreamManagerOptions, NATSError.JetStreamManagerError, never>
  readonly consumers: JetStreamConsumerAPI.JetStreamConsumerAPI
  readonly streams: JetStreamStreamAPI.JetStreamStreamAPI
  readonly direct: JetStreamDirectStreamAPI.JetStreamDirectStreamAPI

  /** @internal */
  readonly jsm: JetStream.JetStreamManager
}

/**
 * @category tags
 * @since 0.1.0
 */
export const JetStreamManager = Context.GenericTag<JetStreamManager>(
  "@effect-messaging/nats/JetStreamManager"
)

const wrap = utils.wrap(NATSError.JetStreamManagerError)
const wrapAsync = utils.wrapAsync(NATSError.JetStreamManagerError)

/** @internal */
export const make = (jsm: JetStream.JetStreamManager): JetStreamManager => ({
  [TypeId]: TypeId,
  accountInfo: wrapAsync(() => jsm.getAccountInfo(), "Failed to get account info"),
  advisoryStream: wrap(() => jsm.advisories(), `Failed to get advisories`).pipe(
    Effect.map((a) =>
      Stream.fromAsyncIterable(
        a,
        (error) =>
          new NATSError.JetStreamManagerError({ reason: `An error occured in advisories async iterable`, cause: error })
      )
    ),
    Stream.unwrap
  ),
  options: wrap(() => jsm.getOptions(), "Failed to get JetStream manager options"),
  consumers: JetStreamConsumerAPI.make(jsm.consumers),
  streams: JetStreamStreamAPI.make(jsm.streams),
  direct: JetStreamDirectStreamAPI.make(jsm.direct),

  jsm
})

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamManagerOptions = {}): Effect.Effect<
  JetStreamManager,
  NATSError.JetStreamManagerError,
  NATSConnection.NATSConnection
> =>
  NATSConnection.NATSConnection.pipe(
    Effect.flatMap(({ nc }) =>
      wrapAsync(() => JetStream.jetstreamManager(nc, options), "Failed to create JetStream manager")
    ),
    Effect.map(make)
  )

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamManagerOptions = {}): Layer.Layer<
  JetStreamManager,
  NATSError.JetStreamManagerError,
  NATSConnection.NATSConnection
> => Layer.scoped(JetStreamManager, makeJetStreamClient(options))
