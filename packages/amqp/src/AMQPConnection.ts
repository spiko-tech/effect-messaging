import type { Channel } from "amqplib"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type * as AMQPError from "./AMQPError.js"
import * as internal from "./internal/AMQPConnection.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPConnection")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface AMQPConnection {
  readonly [TypeId]: TypeId
  readonly createChannel: Effect.Effect<Channel, AMQPError.AMQPConnectionError, never>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const AMQPConnection = Context.GenericTag<AMQPConnection>("@effect-messaging/amqp/AMQPConnection")

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  url: internal.ConnectionUrl
): Effect.Effect<AMQPConnection, AMQPError.AMQPConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const connection = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const connectionRef = yield* internal.ConnectionRef.make()
        yield* internal.initiateConnection(connectionRef, url)
        return {
          [TypeId]: TypeId as TypeId,
          createChannel: internal.createChannel(connectionRef),
          close: internal.closeConnection(connectionRef),
          watchConnection: internal.watchConnection(connectionRef, url)
        }
      }),
      (connection) => connection.close
    )
    yield* Effect.forkScoped(connection.watchConnection)
    return connection
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (url: internal.ConnectionUrl): Layer.Layer<
  AMQPConnection,
  AMQPError.AMQPConnectionError
> => Layer.scoped(AMQPConnection, make(url))
