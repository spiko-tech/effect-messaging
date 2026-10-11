/**
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Stream from "effect/Stream"
import type * as NATSError from "./NATSError.ts"
import type * as NATSMessage from "./NATSMessage.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSSubscription")
/** @since 0.1.0 */
export type TypeId = typeof TypeId

/**
 * Consuming the stream owns subscription cleanup. Stopping or interrupting the
 * stream unsubscribes; drain waits for admitted messages to be processed.
 * @since 0.1.0
 */
export interface NATSSubscription {
  readonly [TypeId]: TypeId
  readonly stream: Stream.Stream<NATSMessage.NATSMessage, NATSError.NATSSubscriptionError>
  readonly unsubscribe: (max?: number) => Effect.Effect<void, NATSError.NATSSubscriptionError>
  /** Moves server interest while retaining this subscription's lifetime counters. @since 1.0.0 */
  readonly resubscribe: (subject: string) => Effect.Effect<void, NATSError.NATSSubscriptionError>
  readonly drain: Effect.Effect<void, NATSError.NATSSubscriptionError>
  readonly closed: Effect.Effect<Option.Option<NATSError.NATSSubscriptionError>>
  readonly isDraining: Effect.Effect<boolean>
  readonly isClosed: Effect.Effect<boolean>
  readonly getSubject: Effect.Effect<string>
  readonly getID: Effect.Effect<number>
  readonly getReceived: Effect.Effect<number>
  readonly getProcessed: Effect.Effect<number>
  readonly getPending: Effect.Effect<number>
  readonly getMax: Effect.Effect<Option.Option<number>>
}
