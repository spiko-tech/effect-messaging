/**
 * @since 0.1.0
 */
import type { ConnectionOptions } from "@nats-io/transport-node"
import { connect } from "@nats-io/transport-node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as NATSError from "./NATSError.js"

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
  readonly close: () => Effect.Effect<void, never, never>
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
  options?: ConnectionOptions
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const connection = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const nc = yield* Effect.tryPromise({
          try: () => connect(options),
          catch: (error) => new NATSError.NATSConnectionError({ reason: "Failed to connect", cause: error })
        })

        return {
          [TypeId]: TypeId,
          close: () => Effect.tryPromise(() => nc.close()).pipe(Effect.orDie)
        } satisfies NATSConnection
      }),
      (connection) => connection.close()
    )

    return connection
  })

/**
 * @since 0.1.0
 * @category Layers
 */

export const layerNode = (options?: ConnectionOptions): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> => Layer.scoped(NATSConnection, makeNode(options))
