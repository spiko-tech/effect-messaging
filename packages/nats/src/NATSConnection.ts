/**
 * @since 0.1.0
 */
import type * as nats_core from "@nats-io/nats-core"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as internal from "./internal/NATSConnection.js"
import type * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSConnection")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSConnection {
  readonly [TypeId]: TypeId
  readonly info: nats_core.ServerInfo | undefined
  readonly close: Effect.Effect<void, never, never>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSConnection = Context.GenericTag<NATSConnection>("@effect-messaging/nats/NATSConnection")

/**
 * @category constructors
 * @since 0.1.0
 */
export const makeNode = (
  options?: nats_core.ConnectionOptions
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      const connection = yield* internal.connectNode(options)

      return {
        [TypeId]: TypeId,
        info: internal.info(connection),
        close: internal.close(connection)
      } satisfies NATSConnection
    }),
    (connection) => connection.close
  )

/**
 * @since 0.1.0
 * @category Layers
 */

export const layerNode = (options?: nats_core.ConnectionOptions): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> => Layer.scoped(NATSConnection, makeNode(options))
