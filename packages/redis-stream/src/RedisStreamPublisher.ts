/**
 * @since 0.1.0
 */
import * as Publisher from "@effect-messaging/core/Publisher"
import * as PublisherError from "@effect-messaging/core/PublisherError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as RedisConnection from "./RedisConnection.js"
import * as RedisError from "./RedisError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/redis-stream/RedisStreamPublisher")

/**
 * @category tags
 * @since 0.1.0
 */
export const RedisStreamPublisher = Context.GenericTag<RedisStreamPublisher>(
  "@effect-messaging/redis-stream/RedisStreamPublisher"
)

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisPublishMessage {
  stream: string
  data: Record<string, string>
}

/**
 * @category models
 * @since 0.1.0
 */
export interface RedisStreamPublisher extends Publisher.Publisher<RedisPublishMessage> {
  readonly [TypeId]: TypeId
}

/** @internal */
const publish = (
  connection: RedisConnection.RedisConnection,
  retrySchedule: Schedule.Schedule<unknown, RedisError.RedisStreamError>
) =>
(message: RedisPublishMessage): Effect.Effect<void, PublisherError.PublisherError, never> =>
  Effect.gen(function*() {
    const client = yield* connection.client.pipe(
      Effect.catchTag(
        "RedisConnectionError",
        (error) => Effect.fail(new PublisherError.PublisherError({ reason: "Connection failed", cause: error }))
      )
    )
    yield* Effect.tryPromise({
      try: () => client.xAdd(message.stream, "*", message.data),
      catch: (error) => new RedisError.RedisStreamError({ reason: "Failed to publish message", cause: error })
    }).pipe(
      Effect.retry(retrySchedule),
      Effect.catchTag(
        "RedisStreamError",
        (error) => Effect.fail(new PublisherError.PublisherError({ reason: "Failed to publish message", cause: error }))
      ),
      Effect.map(() => undefined)
    )
  })

/**
 * @category constructors
 * @since 0.1.0
 */
export interface RedisStreamPublisherConfig {
  readonly retrySchedule?: Schedule.Schedule<unknown, RedisError.RedisStreamError>
}

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  config?: RedisStreamPublisherConfig
): Effect.Effect<RedisStreamPublisher, never, RedisConnection.RedisConnection> =>
  Effect.gen(function*() {
    const connection = yield* RedisConnection.RedisConnection

    const publisher: RedisStreamPublisher = {
      [TypeId]: TypeId,
      [Publisher.TypeId]: Publisher.TypeId,
      publish: publish(connection, config?.retrySchedule ?? Schedule.stop)
    }

    return publisher
  })

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (config?: RedisStreamPublisherConfig): Layer.Layer<
  RedisStreamPublisher,
  never,
  RedisConnection.RedisConnection
> => Layer.effect(RedisStreamPublisher, make(config))
