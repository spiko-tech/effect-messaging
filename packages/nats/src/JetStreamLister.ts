/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type * as utils from "./internal/utils.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamLister")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Lister wrapper with Effect methods
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamLister<T, E> {
  readonly [TypeId]: TypeId
  readonly next: () => Effect.Effect<Array<T>>
  readonly stream: Stream.Stream<T, E, never>

  /** @internal */
  readonly lister: JetStream.Lister<T>
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const make =
  <E>(ErrorClass: utils.NATSErrorConstructor<E>) => <T>(lister: JetStream.Lister<T>): JetStreamLister<T, E> => ({
    [TypeId]: TypeId,
    next: () => Effect.promise(() => lister.next()),
    stream: Stream.fromAsyncIterable(
      lister,
      (error) => new ErrorClass({ reason: "An error occurred in lister async iterable", cause: error })
    ),

    lister
  })
