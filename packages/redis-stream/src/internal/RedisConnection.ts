import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type { RedisClientType } from "redis"
import { createClient } from "redis"
import { RedisConnectionError } from "../RedisError.js"

/** @internal */
export type ConnectionOptions = {
  host?: string
  port?: number
  password?: string
  db?: number
  retryConnectionSchedule?: Schedule.Schedule<unknown, RedisConnectionError>
  waitConnectionTimeout?: Duration.DurationInput
}

export class InternalRedisConnection
  extends Context.Tag("@effect-messaging/redis-stream/InternalRedisConnection")<InternalRedisConnection, {
    clientRef: SubscriptionRef.SubscriptionRef<Option.Option<RedisClientType>>
    options: ConnectionOptions
    retryConnectionSchedule: Schedule.Schedule<unknown, RedisConnectionError>
    waitConnectionTimeout: Duration.DurationInput
  }>()
{
  private static defaultRetryConnectionSchedule = Schedule.forever.pipe(Schedule.addDelay(() => 1000))
  private static defaultWaitConnectionTimeout = Duration.seconds(5)

  static new = (
    options: ConnectionOptions
  ): Effect.Effect<Context.Tag.Service<InternalRedisConnection>> =>
    Effect.gen(function*() {
      const clientRef = yield* SubscriptionRef.make(Option.none<RedisClientType>())
      return {
        clientRef,
        options,
        retryConnectionSchedule: options.retryConnectionSchedule ??
          InternalRedisConnection.defaultRetryConnectionSchedule,
        waitConnectionTimeout: options.waitConnectionTimeout ?? InternalRedisConnection.defaultWaitConnectionTimeout
      }
    })
}

/** @internal */
export const getOrWaitClient = Effect.gen(function*() {
  const { clientRef, waitConnectionTimeout } = yield* InternalRedisConnection
  return yield* clientRef.changes.pipe(
    Stream.takeUntil(Option.isSome),
    Stream.run(Sink.last()),
    Effect.flatten,
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => Effect.dieMessage(`Should never happen: Client should be available here`)
    ),
    Effect.timeout(waitConnectionTimeout),
    Effect.catchTag("TimeoutException", () => new RedisConnectionError({ reason: "Client is not available" }))
  )
})

/** @internal */
export const initiateConnection = Effect.gen(function*() {
  const { clientRef, options } = yield* InternalRedisConnection
  yield* Effect.annotateCurrentSpan({ host: options.host, port: options.port })
  yield* SubscriptionRef.updateEffect(clientRef, () =>
    Effect.gen(function*() {
      const redisClient = createClient({
        socket: {
          host: options.host ?? "localhost",
          port: options.port ?? 6379
        },
        ...(options.password && { password: options.password }),
        database: options.db ?? 0
      })

      const client = yield* Effect.tryPromise({
        try: () => redisClient.connect(),
        catch: (error) => new RedisConnectionError({ reason: "Failed to establish connection", cause: error })
      }).pipe(
        Effect.map(() => redisClient)
      )
      return Option.some(client as any)
    }))
  yield* Effect.logDebug(`RedisConnection: connection established`)
}).pipe(
  Effect.withSpan("RedisConnection.initiateConnection")
)

/** @internal */
export interface CloseConnectionOptions {
  removeAllListeners?: boolean
}

/** @internal */
export const closeConnection = ({ removeAllListeners = true }: CloseConnectionOptions = {}) =>
  Effect.gen(function*() {
    const { clientRef } = yield* InternalRedisConnection
    const client = yield* getOrWaitClient
    yield* Effect.tryPromise({
      try: () => client.quit(),
      catch: (error) => new RedisConnectionError({ reason: "Failed to close connection", cause: error })
    })
    yield* SubscriptionRef.set(clientRef, Option.none())
    yield* Effect.logDebug(`RedisConnection: connection closed`)
  }).pipe(
    Effect.withSpan("RedisConnection.closeConnection"),
    Effect.catchAll((error) => Effect.logError(`RedisConnection: error closing connection: ${error}`))
  )

/** @internal */
export const keepConnectionAlive = Effect.gen(function*() {
  const { clientRef, retryConnectionSchedule } = yield* InternalRedisConnection
  yield* clientRef.changes.pipe(
    Stream.runForEach((clientOption) =>
      Effect.gen(function*() {
        if (Option.isSome(clientOption)) {
          const client = clientOption.value
          yield* Effect.tryPromise({
            try: () => client.ping(),
            catch: (error) => new RedisConnectionError({ reason: "Connection health check failed", cause: error })
          }).pipe(
            Effect.retry(retryConnectionSchedule),
            Effect.forever,
            Effect.fork
          )
        }
      })
    ),
    Effect.fork
  )
}).pipe(
  Effect.withSpan("RedisConnection.keepConnectionAlive"),
  Effect.forkScoped
)

/** @internal */
export const monitorConnectionErrors = Effect.gen(function*() {
  const { clientRef } = yield* InternalRedisConnection
  yield* clientRef.changes.pipe(
    Stream.runForEach((clientOption) =>
      Effect.gen(function*() {
        if (Option.isSome(clientOption)) {
          const client = clientOption.value
          client.on("error", (error) => {
            Effect.runSync(Effect.logError(`RedisConnection: client error: ${error}`))
          })
        }
      })
    ),
    Effect.fork
  )
}).pipe(
  Effect.withSpan("RedisConnection.monitorConnectionErrors"),
  Effect.forkScoped
)
