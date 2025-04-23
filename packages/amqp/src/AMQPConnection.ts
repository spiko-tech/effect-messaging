/**
 * @since 0.1.0
 */
import type { Channel, ConfirmChannel, Connection, ServerProperties } from "amqplib"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schedule from "effect/Schedule"
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
 * @since 0.2.5
 */
export type AMQPConnectionServerProperties = ServerProperties & {
  hostname: string | undefined
  port: string | undefined
}

/**
 * @category models
 * @since 0.1.0
 */
export interface AMQPConnection {
  readonly [TypeId]: TypeId
  readonly createChannel: Effect.Effect<Channel, AMQPError.AMQPConnectionError, never>
  readonly createConfirmChannel: Effect.Effect<ConfirmChannel, AMQPError.AMQPConnectionError, never>
  readonly serverProperties: Effect.Effect<AMQPConnectionServerProperties, AMQPError.AMQPConnectionError, never>
  readonly updateSecret: (
    ...params: Parameters<Connection["updateSecret"]>
  ) => Effect.Effect<void, AMQPError.AMQPConnectionError, never>

  /** @internal */
  readonly close: (options: internal.CloseConnectionOptions) => Effect.Effect<void, never, never>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const AMQPConnection = Context.GenericTag<AMQPConnection>("@effect-messaging/amqp/AMQPConnection")

/**
 * @category models
 * @since 0.1.0
 */
export type AMQPConnectionOptions = {
  url: internal.ConnectionUrl
  retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPError.AMQPConnectionError>
  waitConnectionTimeout?: Duration.DurationInput
}

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: AMQPConnectionOptions
): Effect.Effect<AMQPConnection, AMQPError.AMQPConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const internalConnection = yield* internal.InternalAMQPConnection
    const provideInternal = Effect.provideService(internal.InternalAMQPConnection, internalConnection)

    const connection = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        yield* internal.initiateConnection
        return {
          [TypeId]: TypeId as TypeId,
          createChannel: internal.createChannel.pipe(provideInternal),
          createConfirmChannel: internal.createConfirmChannel.pipe(provideInternal),
          serverProperties: internal.serverProperties.pipe(provideInternal),
          updateSecret: (...params: Parameters<Connection["updateSecret"]>) =>
            internal.updateSecret(...params).pipe(provideInternal),
          close: (opts: internal.CloseConnectionOptions = {}) => internal.closeConnection(opts).pipe(provideInternal)
        }
      }),
      (connection) => connection.close()
    )
    yield* Effect.forkScoped(internal.watchConnection)
    return connection
  }).pipe(
    Effect.provideServiceEffect(internal.InternalAMQPConnection, internal.InternalAMQPConnection.new(options))
  )

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: AMQPConnectionOptions): Layer.Layer<
  AMQPConnection,
  AMQPError.AMQPConnectionError
> => Layer.scoped(AMQPConnection, make(options))
