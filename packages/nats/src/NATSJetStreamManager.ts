/**
 * @since 0.1.0
 */
import * as JetStream from "@nats-io/jetstream"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSJetStreamManager")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSJetStreamManager {
  readonly [TypeId]: TypeId
  readonly accountInfo: Effect.Effect<JetStream.JetStreamAccountStats, NATSError.NATSJetStreamError, never>

  /** @internal */
  readonly jsm: JetStream.JetStreamManager
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSJetStreamManager = Context.GenericTag<NATSJetStreamManager>(
  "@effect-messaging/nats/NATSJetStreamManager"
)

/** @internal */
const wrapPromise = <A>(promise: (signal: AbortSignal) => Promise<A>, errorReason: string) =>
  Effect.tryPromise({
    try: promise,
    catch: (error) => new NATSError.NATSJetStreamError({ reason: errorReason, cause: error })
  })

/** @internal */
const makeJetStreamClient = (options: JetStream.JetStreamManagerOptions = {}): Effect.Effect<
  NATSJetStreamManager,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> =>
  Effect.gen(function*() {
    const { nc } = yield* NATSConnection.NATSConnection
    const jsm = yield* wrapPromise(() => JetStream.jetstreamManager(nc, options), "Failed to create JetStream manager")

    const client: NATSJetStreamManager = {
      [TypeId]: TypeId,
      accountInfo: wrapPromise(() => jsm.getAccountInfo(), "Failed to get account info"),
      jsm
    }

    return client
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: JetStream.JetStreamManagerOptions = {}): Layer.Layer<
  NATSJetStreamManager,
  NATSError.NATSJetStreamError,
  NATSConnection.NATSConnection
> => Layer.scoped(NATSJetStreamManager, makeJetStreamClient(options))
