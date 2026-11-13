/**
 * Scoped logical channels. Deliveries are settled only on their originating session.
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import * as AMQPConnection from "./AMQPConnection.ts"
import type * as AMQPConsumeMessage from "./AMQPConsumeMessage.ts"
import type * as AMQPError from "./AMQPError.ts"
import type * as AMQPTopology from "./AMQPTopology.ts"
import type * as AMQPTypes from "./AMQPTypes.ts"
import { ChannelTypeId } from "./internal/typeIds.ts"

/**
 * @since 0.1.0
 */
export const TypeId: typeof ChannelTypeId = ChannelTypeId

/** @since 0.8.0 */
export interface AMQPChannelOptions {
  /** Opt in to broker confirmations. Defaults to false. */
  readonly confirm?: boolean
  readonly confirmTimeout?: Duration.Input
  readonly waitChannelTimeout?: Duration.Input
  readonly maxUnconfirmed?: number
  /** Per-consumer broker credit, default 50. Zero means unlimited wire credit, not unlimited local buffering. */
  readonly prefetch?: number
}

/** @since 0.1.0 */
export interface AMQPChannel {
  readonly [TypeId]: typeof TypeId
  readonly connection: AMQPConnection.AMQPConnection
  /** Registers a consumer and returns its single-reader stream. Overflow retires it with a visible typed error.
   * Auto-ack deliveries cannot be settled and may be lost on cancellation, overflow or connection loss.
   * Direct Reply-To requires noAck and requests published on this same channel.
   */
  readonly consume: (
    queue: AMQPTopology.QueueName,
    options?: AMQPTypes.ConsumeOptions
  ) => Effect.Effect<Stream.Stream<AMQPConsumeMessage.AMQPConsumeMessage, AMQPError.AMQPError>, AMQPError.AMQPError>
  readonly ack: (
    message: AMQPConsumeMessage.AMQPConsumeMessage,
    allUpTo?: boolean
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly nack: (
    message: AMQPConsumeMessage.AMQPConsumeMessage,
    allUpTo?: boolean,
    requeue?: boolean
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly reject: (
    message: AMQPConsumeMessage.AMQPConsumeMessage,
    requeue?: boolean
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly ackAll: () => Effect.Effect<void, AMQPError.AMQPError>
  readonly nackAll: (requeue?: boolean) => Effect.Effect<void, AMQPError.AMQPError>
  /** Completes after a backpressured write, or a broker confirm when confirm is enabled. */
  readonly publish: (
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    options?: AMQPTypes.PublishOptions
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly sendToQueue: (
    queue: AMQPTopology.QueueName,
    content: Uint8Array,
    options?: AMQPTypes.PublishOptions
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly assertQueue: (
    queue?: string,
    options?: AMQPTypes.QueueOptions
  ) => Effect.Effect<AMQPTopology.QueueReference, AMQPError.AMQPError>
  readonly checkQueue: (queue: AMQPTopology.QueueName) => Effect.Effect<AMQPTypes.QueueReply, AMQPError.AMQPError>
  readonly deleteQueue: (
    queue: AMQPTopology.QueueName,
    options?: { readonly ifUnused?: boolean; readonly ifEmpty?: boolean }
  ) => Effect.Effect<{ readonly messageCount: number }, AMQPError.AMQPError>
  readonly purgeQueue: (
    queue: AMQPTopology.QueueName
  ) => Effect.Effect<{ readonly messageCount: number }, AMQPError.AMQPError>
  readonly bindQueue: (
    queue: AMQPTopology.QueueName,
    exchange: string,
    routingKey: string,
    args?: AMQPTypes.FieldTable
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly unbindQueue: (
    queue: AMQPTopology.QueueName,
    exchange: string,
    routingKey: string,
    args?: AMQPTypes.FieldTable
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly assertExchange: (
    exchange: string,
    type: string,
    options?: AMQPTypes.ExchangeOptions
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly checkExchange: (exchange: string) => Effect.Effect<void, AMQPError.AMQPError>
  readonly deleteExchange: (
    exchange: string,
    options?: { readonly ifUnused?: boolean }
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly bindExchange: (
    destination: string,
    source: string,
    routingKey: string,
    args?: AMQPTypes.FieldTable
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly unbindExchange: (
    destination: string,
    source: string,
    routingKey: string,
    args?: AMQPTypes.FieldTable
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly cancel: (consumerTag: string) => Effect.Effect<void, AMQPError.AMQPError>
  /** Pull one delivery. noAck defaults to false; automatically acknowledged deliveries have no settlement authority. */
  readonly get: (
    queue: AMQPTopology.QueueName,
    options?: AMQPTypes.GetOptions
  ) => Effect.Effect<Option.Option<AMQPConsumeMessage.AMQPConsumeMessage>, AMQPError.AMQPError>
  /** Set future-consumer broker credit; zero removes the wire limit. Existing consumer/mailbox credit stays fixed. */
  readonly prefetch: (count: number, global?: boolean) => Effect.Effect<void, AMQPError.AMQPError>
  /** Request broker recovery of unstaged, unacknowledged receipts. requeue defaults to true.
   * Staged transactional settlements survive recovery and can still be rolled back.
   * The optional argument is available since 1.0.0-beta.0. RabbitMQ rejects false with a connection-closing
   * NOT_IMPLEMENTED (540); the broker error remains visible rather than being treated as successful recovery.
   * @category consumers
   */
  readonly recover: (requeue?: boolean) => Effect.Effect<void, AMQPError.AMQPError>
  /** Request peer channel flow and return the active value in flow-ok.
   * RabbitMQ accepts true but rejects false with connection-closing NOT_IMPLEMENTED (540).
   * @since 1.0.0-beta.0
   * @category flow control
   */
  readonly flow: (active: boolean) => Effect.Effect<boolean, AMQPError.AMQPError>
  /** Select transactions (incompatible with confirmations). Mode survives recovery; pending work does not.
   * @since 1.0.0-beta.0
   * @category transactions
   */
  readonly txSelect: () => Effect.Effect<void, AMQPError.AMQPError>
  /** Completes on commit-ok. A lost reply has an Unknown outcome and must not be blindly retried.
   * @since 1.0.0-beta.0
   * @category transactions
   */
  readonly txCommit: () => Effect.Effect<void, AMQPError.AMQPError>
  /** Discard this session's pending transaction. Completes on rollback-ok.
   * After recovery, clears the lost-work fence; cannot undo an uncertain commit in an old session.
   * @since 1.0.0-beta.0
   * @category transactions
   */
  readonly txRollback: () => Effect.Effect<void, AMQPError.AMQPError>
  readonly returns: Stream.Stream<AMQPTypes.ReturnedMessage, AMQPError.AMQPError>
  readonly close: Effect.Effect<void>
}

/** @since 0.1.0 */
export const AMQPChannel = Context.Service<AMQPChannel>("@effect-messaging/amqp/AMQPChannel")

/** @since 0.1.0 */
export const make = (options: AMQPChannelOptions = {}): Effect.Effect<
  AMQPChannel,
  AMQPError.AMQPError,
  Scope.Scope | AMQPConnection.AMQPConnection
> => Effect.flatMap(AMQPConnection.AMQPConnection, (connection) => connection.createChannel(options))

/** @since 0.1.0 */
export const layer = (options: AMQPChannelOptions = {}): Layer.Layer<
  AMQPChannel,
  AMQPError.AMQPError,
  AMQPConnection.AMQPConnection
> => Layer.effect(AMQPChannel, make(options))
