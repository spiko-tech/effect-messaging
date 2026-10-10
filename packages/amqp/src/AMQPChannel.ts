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
  readonly prefetch?: number
}

/** @since 0.1.0 */
export interface AMQPChannel {
  readonly [TypeId]: typeof TypeId
  readonly connection: AMQPConnection.AMQPConnection
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
  readonly get: (
    queue: AMQPTopology.QueueName
  ) => Effect.Effect<Option.Option<AMQPConsumeMessage.AMQPConsumeMessage>, AMQPError.AMQPError>
  readonly prefetch: (count: number, global?: boolean) => Effect.Effect<void, AMQPError.AMQPError>
  readonly recover: () => Effect.Effect<void, AMQPError.AMQPError>
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
