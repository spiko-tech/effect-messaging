import type { Channel } from "amqplib"
import type { Scope } from "effect"
import { Context, Effect, Layer } from "effect"
import type { AMQPConnectionError } from "./AMQPError.js"
import * as internal from "./internal/AMQPConnection.js"

/**
 * @category type ids
 * @since 0.2.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPConnection")

/**
 * @category type ids
 * @since 0.2.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.2.0
 */
export interface AMQPConnection {
  readonly [TypeId]: TypeId
  readonly createChannel: Effect.Effect<Channel, AMQPConnectionError, never>
}

/**
 * @category tags
 * @since 0.2.0
 */
export const AMQPConnection = Context.GenericTag<AMQPConnection>("@effect-messaging/amqp/AMQPConnection")

/**
 * @category constructors
 * @since 0.2.0
 */
export const make = (url: internal.ConnectionUrl): Effect.Effect<AMQPConnection, AMQPConnectionError, Scope.Scope> =>
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
 * @since 0.2.0
 * @category Layers
 */
export const layer = (url: internal.ConnectionUrl): Layer.Layer<
  AMQPConnection,
  AMQPConnectionError
> => Layer.scoped(AMQPConnection, make(url))
