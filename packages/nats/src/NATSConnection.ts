/**
 * @since 0.1.0
 */
import type { ConnectionOptions, NatsConnection } from "nats"
import { connect } from "nats"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
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
  readonly connection: NatsConnection
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
export const make = (connection: NatsConnection): NATSConnection => ({
  [TypeId]: TypeId,
  connection
})

/**
 * @category constructors
 * @since 0.1.0
 */
export const makeConnection = (
  options?: ConnectionOptions
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    try {
      const natsConnection = yield* Effect.promise(() => connect(options))
      const connection = make(natsConnection)
      
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => natsConnection.drain())
      )
      
      return connection
    } catch (error) {
      return yield* Effect.fail(
        new NATSError.NATSConnectionError({
          reason: `Failed to connect to NATS: ${error}`,
          cause: error as any
        })
      )
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.fail(
        new NATSError.NATSConnectionError({
          reason: `Failed to connect to NATS: ${error}`,
          cause: error as any
        })
      )
    )
  )

/**
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options?: ConnectionOptions
) =>
  Layer.scoped(NATSConnection, makeConnection(options))

/**
 * @category layers
 * @since 0.1.0
 */
export const layerWithRetry = (
  options?: ConnectionOptions,
  retrySchedule?: Schedule.Schedule<unknown, unknown, unknown>
) =>
  Layer.scoped(
    NATSConnection,
    makeConnection(options).pipe(
      Effect.retry(retrySchedule ?? Schedule.exponential("1 second").pipe(Schedule.intersect(Schedule.recurs(5))))
    )
  )

/**
 * @category utils
 * @since 0.1.0
 */
export const close = (natsConnection: NATSConnection): Effect.Effect<void, never, never> =>
  Effect.promise(() => natsConnection.connection.drain())

/**
 * @category utils
 * @since 0.1.0
 */
export const closed = (natsConnection: NATSConnection): Effect.Effect<Error | undefined, never, never> =>
  Effect.promise(() => natsConnection.connection.closed()).pipe(
    Effect.map((error) => error ?? undefined)
  )

/**
 * @category utils
 * @since 0.1.0
 */
export const isClosed = (natsConnection: NATSConnection): boolean =>
  natsConnection.connection.isClosed()

/**
 * @category utils
 * @since 0.1.0
 */
export const isDraining = (natsConnection: NATSConnection): boolean =>
  natsConnection.connection.isDraining()