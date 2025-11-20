/**
 * @since 0.1.0
 */
import * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as utils from "./internal/utils.js"
import * as JetStreamBatch from "./JetStreamBatch.js"
import * as JetStreamConsumers from "./JetStreamConsumer.js"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamClient")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Client
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamClient {
  readonly [TypeId]: TypeId
  readonly apiPrefix: string
  readonly publish: (
    ...params: Parameters<JetStream.JetStreamClient["publish"]>
  ) => Effect.Effect<JetStream.PubAck, NATSError.JetStreamClientError, void>
  readonly startBatch: (
    ...params: Parameters<JetStream.JetStreamClient["startBatch"]>
  ) => Effect.Effect<JetStreamBatch.JetStreamBatch, NATSError.JetStreamClientError, void>
  readonly options: Effect.Effect<JetStream.JetStreamOptions, NATSError.JetStreamClientError, never>
  readonly consumers: JetStreamConsumers.Consumers

  /** @internal */
  readonly js: JetStream.JetStreamClient
}

/**
 * @category tags
 * @since 0.1.0
 */
export const JetStreamClient = Context.GenericTag<JetStreamClient>("@effect-messaging/nats/JetStreamClient")

const wrapAsync = utils.wrapAsync(NATSError.JetStreamClientError)
const wrap = utils.wrap(NATSError.JetStreamClientError)

/** @internal */
export const make = (js: JetStream.JetStreamClient): JetStreamClient => ({
  [TypeId]: TypeId,
  apiPrefix: js.apiPrefix,
  publish: (...params: Parameters<JetStream.JetStreamClient["publish"]>) =>
    wrapAsync(() => js.publish(...params), `Failed to publish message`),
  startBatch: (...params: Parameters<JetStream.JetStreamClient["startBatch"]>) =>
    wrapAsync(() => js.startBatch(...params), `Failed to start batch`).pipe(
      Effect.map(JetStreamBatch.make)
    ),
  options: wrap(() => js.getOptions(), "Failed to get JetStream options"),
  consumers: JetStreamConsumers.makeConsumers(js.consumers),
  js
})

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamOptions = {}): Effect.Effect<
  JetStreamClient,
  NATSError.JetStreamClientError,
  NATSConnection.NATSConnection
> =>
  NATSConnection.NATSConnection.pipe(
    Effect.flatMap(({ nc }) => wrap(() => JetStream.jetstream(nc, options), "Failed to create JetStream client")),
    Effect.map(make)
  )

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamOptions = {}): Layer.Layer<
  JetStreamClient,
  NATSError.JetStreamClientError,
  NATSConnection.NATSConnection
> => Layer.scoped(JetStreamClient, makeJetStreamClient(options))
