/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import type { RedisClientType } from "redis"
import * as internal from "./internal/RedisConnection.js"
import * as RedisError from "./RedisError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/redis-stream/RedisConnection")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisConnection {
  readonly [TypeId]: TypeId
  readonly client: Effect.Effect<RedisClientType, RedisError.RedisConnectionError, never>
  readonly ping: Effect.Effect<string, RedisError.RedisConnectionError, never>
  readonly quit: Effect.Effect<void, RedisError.RedisConnectionError, never>

  /** @internal */
  readonly close: (options: internal.CloseConnectionOptions) => Effect.Effect<void, never, never>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const RedisConnection = Context.GenericTag<RedisConnection>("@effect-messaging/redis-stream/RedisConnection")

/**
 * @category models
 * @since 0.1.0
 */
export type RedisConnectionOptions = {
  host?: string
  port?: number
  password?: string
  db?: number
  retryConnectionSchedule?: Schedule.Schedule<unknown, RedisError.RedisConnectionError>
  waitConnectionTimeout?: Duration.DurationInput
}

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: RedisConnectionOptions = {}
): Effect.Effect<RedisConnection, RedisError.RedisConnectionError, Scope.Scope> =>
  Effect.gen(function*() {
    const internalConnection = yield* internal.InternalRedisConnection
    const provideInternal = Effect.provideService(internal.InternalRedisConnection, internalConnection)

    const connection = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        yield* internal.initiateConnection
        return {
          [TypeId]: TypeId as TypeId,
          client: internal.getOrWaitClient.pipe(provideInternal),
          ping: Effect.gen(function*() {
            const client = yield* internal.getOrWaitClient.pipe(provideInternal)
            return yield* Effect.tryPromise({
              try: () => client.ping(),
              catch: (error) => new RedisError.RedisConnectionError({ reason: "Ping failed", cause: error })
            })
          }) as Effect.Effect<string, RedisError.RedisConnectionError, never>,
          quit: Effect.gen(function*() {
            const client = yield* internal.getOrWaitClient.pipe(provideInternal)
            return yield* Effect.tryPromise({
              try: () => client.quit(),
              catch: (error) => new RedisError.RedisConnectionError({ reason: "Quit failed", cause: error })
            })
          }) as Effect.Effect<void, RedisError.RedisConnectionError, never>,
          close: (opts: internal.CloseConnectionOptions = {}) => internal.closeConnection(opts).pipe(provideInternal)
        }
      }),
      (connection) => connection.close()
    )
    yield* Effect.forkScoped(internal.keepConnectionAlive)
    yield* Effect.forkScoped(internal.monitorConnectionErrors)
    return connection
  }).pipe(
    Effect.provideServiceEffect(internal.InternalRedisConnection, internal.InternalRedisConnection.new(options))
  )

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (
  options: RedisConnectionOptions = {}
): Layer.Layer<RedisConnection, RedisError.RedisConnectionError> => Layer.scoped(RedisConnection, make(options))
