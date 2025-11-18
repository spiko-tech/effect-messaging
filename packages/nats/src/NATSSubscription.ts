/**
 * @since 0.1.0
 */
import type * as NATSCore from "@nats-io/nats-core"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as utils from "./internal/utils.js"
import * as NATSError from "./NATSError.js"
import * as NATSMessage from "./NATSMessage.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSSubscription")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS Message
 *
 * @category models
 * @since 0.1.0
 */
export interface NATSSubscription {
  readonly [TypeId]: TypeId
  readonly stream: Stream.Stream<NATSMessage.NATSMessage, NATSError.NATSSubscriptionError>

  readonly unsubscribe: (
    ...params: Parameters<NATSCore.Subscription["unsubscribe"]>
  ) => Effect.Effect<void, NATSError.NATSSubscriptionError>
  readonly drain: Effect.Effect<void, NATSError.NATSSubscriptionError>
  readonly isDraining: Effect.Effect<boolean, NATSError.NATSSubscriptionError>
  readonly isClosed: Effect.Effect<boolean, NATSError.NATSSubscriptionError>
  readonly getSubject: Effect.Effect<string, NATSError.NATSSubscriptionError>
  readonly getReceived: Effect.Effect<number, NATSError.NATSSubscriptionError>
  readonly getProcessed: Effect.Effect<number, NATSError.NATSSubscriptionError>
  readonly getPending: Effect.Effect<number, NATSError.NATSSubscriptionError>
  readonly getMax: Effect.Effect<Option.Option<number>, NATSError.NATSSubscriptionError>

  /** @internal */
  readonly sub: NATSCore.Subscription
}

const wrapAsync = utils.wrapAsync(NATSError.NATSSubscriptionError)
const wrap = utils.wrap(NATSError.NATSSubscriptionError)

/** @internal */
export const make = (sub: NATSCore.Subscription): NATSSubscription => ({
  [TypeId]: TypeId,
  stream: Stream.fromAsyncIterable(
    sub,
    (error) => new NATSError.NATSSubscriptionError({ reason: "Failed to read from NATS subscription", cause: error })
  ).pipe(Stream.map(NATSMessage.make)),
  unsubscribe: (...params: Parameters<NATSCore.Subscription["unsubscribe"]>) =>
    wrap(() => sub.unsubscribe(...params), "Failed to unsubscribe NATS subscription"),
  drain: wrapAsync(() => sub.drain(), "Failed to drain NATS subscription"),
  isDraining: wrap(
    () => sub.isDraining(),
    "Failed to get draining state of NATS subscription"
  ),
  isClosed: wrap(() => sub.isClosed(), "Failed to get closed state of NATS subscription"),
  getSubject: wrap(() => sub.getSubject(), "Failed to get subject of NATS subscription"),
  getReceived: wrap(
    () => sub.getReceived(),
    "Failed to get received count of NATS subscription"
  ),
  getProcessed: wrap(
    () => sub.getProcessed(),
    "Failed to get processed count of NATS subscription"
  ),
  getPending: wrap(
    () => sub.getPending(),
    "Failed to get pending count of NATS subscription"
  ),
  getMax: wrap(
    () => Option.fromNullable(sub.getMax()),
    "Failed to get max of NATS subscription"
  ),
  sub
})
