/**
 * A queue-backed message stream with native Effect lifecycle and counters.
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSQueuedIterator")
/** @since 0.1.0 */
export type TypeId = typeof TypeId

/** @since 0.1.0 */
export interface NATSQueuedIterator<T, E> {
  readonly [TypeId]: TypeId
  readonly stop: (error?: Error) => Effect.Effect<void>
  readonly getProcessed: Effect.Effect<number>
  readonly getPending: Effect.Effect<number>
  readonly getReceived: Effect.Effect<number>
  readonly stream: Stream.Stream<T, E>
}

/** @internal */
export const make = <T, E>(
  queue: Queue.Queue<T, E | Cause.Done>,
  stop: (error?: Error) => Effect.Effect<void>,
  received: Effect.Effect<number>
): NATSQueuedIterator<T, E> => {
  let processed = 0
  return {
    [TypeId]: TypeId,
    stop,
    getProcessed: Effect.sync(() => processed),
    getPending: Queue.size(queue),
    getReceived: received,
    stream: Stream.fromQueue(queue).pipe(
      Stream.map((value) => {
        processed++
        return value
      }),
      Stream.ensuring(stop())
    )
  }
}
