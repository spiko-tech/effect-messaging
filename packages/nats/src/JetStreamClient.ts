/**
 * @since 0.1.0
 */
import * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as utils from "./internal/utils.js"
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
  ) => Effect.Effect<JetStream.PubAck, NATSError.NATSJetStreamError, void>
  readonly startBatch: (
    ...params: Parameters<JetStream.JetStreamClient["startBatch"]>
  ) => Effect.Effect<JetStream.Batch, NATSError.NATSJetStreamError, void>

  /** @internal */
  readonly js: JetStream.JetStreamClient
}

/**
 * @category tags
 * @since 0.1.0
 */
export const JetStreamClient = Context.GenericTag<JetStreamClient>("@effect-messaging/nats/JetStreamClient")

const wrapAsync = utils.wrapAsync(NATSError.NATSJetStreamError)
const wrap = utils.wrap(NATSError.NATSJetStreamError)

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamOptions = {}): Effect.Effect<
  JetStreamClient,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const { nc } = yield* NATSConnection.NATSConnection
    const js = yield* wrap(
      () => JetStream.jetstream(nc, options),
      "Failed to create JetStream client"
    )

    const client: JetStreamClient = {
      [TypeId]: TypeId,
      apiPrefix: js.apiPrefix,
      publish: (...params: Parameters<JetStream.JetStreamClient["publish"]>) =>
        wrapAsync(() => js.publish(...params), `Failed to publish message`),
      startBatch: (...params: Parameters<JetStream.JetStreamClient["startBatch"]>) =>
        wrapAsync(() => js.startBatch(...params), `Failed to start batch`),
      js
    }

    return client
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamOptions = {}): Layer.Layer<
  JetStreamClient,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> => Layer.scoped(JetStreamClient, makeJetStreamClient(options))
