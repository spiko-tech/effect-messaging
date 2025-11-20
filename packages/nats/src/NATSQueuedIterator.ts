/**
 * @since 0.1.0
 */
import type * as NATS from "@nats-io/nats-core"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as utils from "./internal/utils.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSQueuedIterator")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS QueuedIterator wrapper with Effect methods
 *
 * @category models
 * @since 0.1.0
 */
export interface NATSQueuedIterator<T, E> {
  readonly [TypeId]: TypeId
  readonly stop: (err?: Error) => Effect.Effect<void>
  readonly getProcessed: Effect.Effect<number>
  readonly getPending: Effect.Effect<number>
  readonly getReceived: Effect.Effect<number>
  readonly stream: Stream.Stream<T, E, never>

  /** @internal */
  readonly iterator: NATS.QueuedIterator<T>
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = <E>(ErrorClass: utils.NATSErrorConstructor<E>) =>
<T>(
  iterator: NATS.QueuedIterator<T>
): NATSQueuedIterator<T, E> => ({
  [TypeId]: TypeId,
  stop: (err?: Error) => Effect.sync(() => iterator.stop(err)),
  getProcessed: Effect.sync(() => iterator.getProcessed()),
  getPending: Effect.sync(() => iterator.getPending()),
  getReceived: Effect.sync(() => iterator.getReceived()),
  stream: Stream.fromAsyncIterable(
    iterator,
    (error) => new ErrorClass({ reason: "An error occurred in queued iterator async iterable", cause: error })
  ),

  iterator
})
