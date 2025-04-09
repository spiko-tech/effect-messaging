import type { Channel, ConsumeMessage, Replies } from "amqplib"
import type { Scope, Stream } from "effect"
import { Context, Effect, Layer } from "effect"
import type { AMQPConnection } from "./AMQPConnection.js"
import type { AMQPChannelError, AMQPConnectionError } from "./AMQPError.js"
import {
  ChannelRef,
  closeChannel,
  consume,
  initiateChannel,
  watchChannel,
  wrapChannelMethod
} from "./internal/AMQPChannel.js"

/**
 * @category type ids
 * @since 0.2.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPChannel")

/**
 * @category type ids
 * @since 0.2.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.2.0
 */
export interface AMQPChannel {
  readonly [TypeId]: TypeId
  readonly consume: (queueName: string) => Stream.Stream<ConsumeMessage, AMQPChannelError>
  readonly ack: (...parameters: Parameters<Channel["ack"]>) => Effect.Effect<void, AMQPChannelError>
  readonly nack: (...parameters: Parameters<Channel["nack"]>) => Effect.Effect<void, AMQPChannelError>
  readonly publish: (...parameters: Parameters<Channel["publish"]>) => Effect.Effect<boolean, AMQPChannelError>
  readonly assertQueue: (
    ...parameters: Parameters<Channel["assertQueue"]>
  ) => Effect.Effect<Replies.AssertQueue, AMQPChannelError>
  readonly bindQueue: (
    ...parameters: Parameters<Channel["bindQueue"]>
  ) => Effect.Effect<Replies.Empty, AMQPChannelError>
  readonly unbindQueue: (
    ...parameters: Parameters<Channel["unbindQueue"]>
  ) => Effect.Effect<Replies.Empty, AMQPChannelError>
  readonly assertExchange: (
    ...parameters: Parameters<Channel["assertExchange"]>
  ) => Effect.Effect<Replies.AssertExchange, AMQPChannelError>
  readonly checkExchange: (
    ...parameters: Parameters<Channel["checkExchange"]>
  ) => Effect.Effect<Replies.Empty, AMQPChannelError>
}

/**
 * @category tags
 * @since 0.2.0
 */
export const AMQPChannel = Context.GenericTag<AMQPChannel>("@effect-messaging/amqp/AMQPChannel")

/**
 * @category constructors
 * @since 0.2.0
 */
export const make: Effect.Effect<AMQPChannel, AMQPChannelError | AMQPConnectionError, Scope.Scope | AMQPConnection> =
  Effect.gen(
    function*() {
      const channel = yield* Effect.acquireRelease(
        Effect.gen(function*() {
          const channelRef = yield* ChannelRef.make()
          yield* initiateChannel(channelRef)
          return {
            [TypeId]: TypeId as TypeId,
            consume: (queueName: string) => consume(channelRef, queueName),
            ack: (...params: Parameters<Channel["ack"]>) =>
              wrapChannelMethod(channelRef, "ack", async (channel) => channel.ack(...params)),
            nack: (...params: Parameters<Channel["nack"]>) =>
              wrapChannelMethod(channelRef, "nack", async (channel) => channel.nack(...params)),
            publish: (...params: Parameters<Channel["publish"]>) =>
              wrapChannelMethod(channelRef, "publish", async (channel) => channel.publish(...params)),
            assertQueue: (...params: Parameters<Channel["assertQueue"]>) =>
              wrapChannelMethod(channelRef, "assertQueue", async (channel) => channel.assertQueue(...params)),
            bindQueue: (...params: Parameters<Channel["bindQueue"]>) =>
              wrapChannelMethod(channelRef, "bindQueue", async (channel) => channel.bindQueue(...params)),
            unbindQueue: (...params: Parameters<Channel["unbindQueue"]>) =>
              wrapChannelMethod(channelRef, "unbindQueue", async (channel) => channel.unbindQueue(...params)),
            assertExchange: (...params: Parameters<Channel["assertExchange"]>) =>
              wrapChannelMethod(channelRef, "assertExchange", async (channel) => channel.assertExchange(...params)),
            checkExchange: (...params: Parameters<Channel["checkExchange"]>) =>
              wrapChannelMethod(channelRef, "checkExchange", async (channel) => channel.checkExchange(...params)),
            close: closeChannel(channelRef),
            watchChannel: watchChannel(channelRef)
          }
        }),
        (channel) => channel.close
      )
      yield* Effect.forkScoped(channel.watchChannel)
      return channel
    }
  )

/**
 * @since 0.2.0
 * @category Layers
 */
export const layer: Layer.Layer<
  AMQPChannel,
  AMQPChannelError | AMQPConnectionError,
  AMQPConnection
> = Layer.scoped(AMQPChannel, make)
