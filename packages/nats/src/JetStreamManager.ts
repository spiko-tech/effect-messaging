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
  readonly accountInfo: Effect.Effect<JetStream.JetStreamAccountStats, NATSError.NATSJetStreamError, never>

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

const wrapAsync = utils.wrapAsync(NATSError.NATSJetStreamError)

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamManagerOptions = {}): Effect.Effect<
  JetStreamManager,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const { nc } = yield* NATSConnection.NATSConnection
    const jsm = yield* wrapAsync(
      () => JetStream.jetstreamManager(nc, options),
      "Failed to create JetStream manager"
    )

    const client: JetStreamManager = {
      [TypeId]: TypeId,
      accountInfo: wrapAsync(() => jsm.getAccountInfo(), "Failed to get account info"),
      jsm
    }

    return client
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamManagerOptions = {}): Layer.Layer<
  JetStreamManager,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> => Layer.scoped(JetStreamManager, makeJetStreamClient(options))
