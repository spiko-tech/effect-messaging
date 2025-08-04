/**
 * @since 0.1.0
 */
import * as Publisher from "@effect-messaging/core/Publisher"
import * as PublisherError from "@effect-messaging/core/PublisherError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as NATSConnection from "./NATSConnection.js"
import type * as NATSMessage from "./NATSMessage.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSPublisher")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSPublisher extends Publisher.Publisher<NATSMessage.NATSPublishMessage> {
  readonly [TypeId]: TypeId
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSPublisher = Context.GenericTag<NATSPublisher>("@effect-messaging/nats/NATSPublisher")

/** @internal */
const publish = (
  connection: NATSConnection.NATSConnection,
  retrySchedule: Schedule.Schedule<unknown, PublisherError.PublisherError>
) =>
(message: NATSMessage.NATSPublishMessage): Effect.Effect<void, PublisherError.PublisherError, never> =>
  Effect.try({
    try: () => {
      connection.connection.publish(message.subject, message.data, message.options)
    },
    catch: (error) =>
      new PublisherError.PublisherError({
        reason: `Failed to publish message to subject ${message.subject}: ${error}`,
        cause: error as any
      })
  }).pipe(
    Effect.retry(retrySchedule),
    Effect.catchAll((error) =>
      Effect.fail(
        new PublisherError.PublisherError({
          reason: `Failed to publish message after retries: ${error}`,
          cause: error as any
        })
      )
    )
  )

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  connection: NATSConnection.NATSConnection,
  retrySchedule?: Schedule.Schedule<unknown, PublisherError.PublisherError>
): NATSPublisher => {
  const publishFn = publish(
    connection,
    retrySchedule ?? Schedule.exponential("100 millis").pipe(Schedule.intersect(Schedule.recurs(3)))
  )

  return {
    [TypeId]: TypeId,
    [Publisher.TypeId]: Publisher.TypeId,
    publish: publishFn
  }
}

/**
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  retrySchedule?: Schedule.Schedule<unknown, PublisherError.PublisherError>
): Layer.Layer<NATSPublisher, never, NATSConnection.NATSConnection> =>
  Layer.effect(
    NATSPublisher,
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      return make(connection, retrySchedule)
    })
  )
