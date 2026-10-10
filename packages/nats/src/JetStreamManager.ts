/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Stream from "effect/Stream"
import * as internal from "./internal/jetstreamServices.ts"
import type * as JetStreamClient from "./JetStreamClient.ts"
import type * as JetStreamConsumerAPI from "./JetStreamConsumerAPI.ts"
import type * as JetStreamDirectStreamAPI from "./JetStreamDirectStreamAPI.ts"
import type * as JetStreamStreamAPI from "./JetStreamStreamAPI.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSConnection from "./NATSConnection.ts"
import type * as NATSError from "./NATSError.ts"

/** @since 0.1.0 */
export const TypeId: typeof internal.ManagerTypeId = internal.ManagerTypeId
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamManager {
  readonly [TypeId]: TypeId
  readonly accountInfo: Effect.Effect<T.JetStreamAccountStats, NATSError.JetStreamManagerError>
  readonly advisoryStream: Stream.Stream<T.Advisory, NATSError.JetStreamManagerError>
  readonly options: Effect.Effect<T.JetStreamManagerOptions, NATSError.JetStreamManagerError>
  readonly consumers: JetStreamConsumerAPI.JetStreamConsumerAPI
  readonly streams: JetStreamStreamAPI.JetStreamStreamAPI
  readonly direct: JetStreamDirectStreamAPI.JetStreamDirectStreamAPI
  readonly jetstream: Effect.Effect<JetStreamClient.JetStreamClient>
}
/** @since 0.1.0 */
export const JetStreamManager = Context.Service<JetStreamManager>("@effect-messaging/nats/JetStreamManager")

/** @since 1.0.0 */
export const make = internal.makeManager
/** @since 0.1.0 */
export const layer = (options: T.JetStreamManagerOptions = {}): Layer.Layer<
  JetStreamManager,
  NATSError.JetStreamManagerError,
  NATSConnection.NATSConnection
> =>
  Layer.effect(
    JetStreamManager,
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const manager = make(connection, options)
      if (options.checkAPI !== false) yield* manager.accountInfo
      return manager
    })
  )
