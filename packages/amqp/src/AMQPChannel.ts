/**
 * @since 0.1.0
 */
import type { Channel, GetMessage, Replies } from "amqplib"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import * as AMQPConnection from "./AMQPConnection.js"
import type * as AMQPConsumeMessage from "./AMQPConsumeMessage.js"
import type * as AMQPError from "./AMQPError.js"
import * as internal from "./internal/AMQPChannel.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPChannel")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface AMQPChannel {
  readonly [TypeId]: TypeId
  readonly connection: AMQPConnection.AMQPConnection
  readonly consume: (
    queueName: string
  ) => Stream.Stream<AMQPConsumeMessage.AMQPConsumeMessage, AMQPError.AMQPChannelError>
  readonly ack: (...parameters: Parameters<Channel["ack"]>) => Effect.Effect<void, AMQPError.AMQPChannelError>
  readonly ackAll: (...parameters: Parameters<Channel["ackAll"]>) => Effect.Effect<void, AMQPError.AMQPChannelError>
  readonly nack: (...parameters: Parameters<Channel["nack"]>) => Effect.Effect<void, AMQPError.AMQPChannelError>
  readonly nackAll: (...parameters: Parameters<Channel["nackAll"]>) => Effect.Effect<void, AMQPError.AMQPChannelError>
  readonly reject: (...parameters: Parameters<Channel["reject"]>) => Effect.Effect<void, AMQPError.AMQPChannelError>
  readonly publish: (
    ...parameters: Parameters<Channel["publish"]>
  ) => Effect.Effect<boolean, AMQPError.AMQPChannelError>
  readonly sendToQueue: (
    ...parameters: Parameters<Channel["sendToQueue"]>
  ) => Effect.Effect<boolean, AMQPError.AMQPChannelError>
  readonly assertQueue: (
    ...parameters: Parameters<Channel["assertQueue"]>
  ) => Effect.Effect<Replies.AssertQueue, AMQPError.AMQPChannelError>
  readonly checkQueue: (
    ...parameters: Parameters<Channel["checkQueue"]>
  ) => Effect.Effect<Replies.AssertQueue, AMQPError.AMQPChannelError>
  readonly deleteQueue: (
    ...parameters: Parameters<Channel["deleteQueue"]>
  ) => Effect.Effect<Replies.DeleteQueue, AMQPError.AMQPChannelError>
  readonly purgeQueue: (
    ...parameters: Parameters<Channel["purgeQueue"]>
  ) => Effect.Effect<Replies.PurgeQueue, AMQPError.AMQPChannelError>
  readonly bindQueue: (
    ...parameters: Parameters<Channel["bindQueue"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly unbindQueue: (
    ...parameters: Parameters<Channel["unbindQueue"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly assertExchange: (
    ...parameters: Parameters<Channel["assertExchange"]>
  ) => Effect.Effect<Replies.AssertExchange, AMQPError.AMQPChannelError>
  readonly checkExchange: (
    ...parameters: Parameters<Channel["checkExchange"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly deleteExchange: (
    ...parameters: Parameters<Channel["deleteExchange"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly bindExchange: (
    ...parameters: Parameters<Channel["bindExchange"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly unbindExchange: (
    ...parameters: Parameters<Channel["unbindExchange"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly cancel: (
    ...parameters: Parameters<Channel["cancel"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly get: (
    ...parameters: Parameters<Channel["get"]>
  ) => Effect.Effect<GetMessage | false, AMQPError.AMQPChannelError>
  readonly prefetch: (
    ...parameters: Parameters<Channel["prefetch"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
  readonly recover: (
    ...parameters: Parameters<Channel["recover"]>
  ) => Effect.Effect<Replies.Empty, AMQPError.AMQPChannelError>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const AMQPChannel = Context.GenericTag<AMQPChannel>("@effect-messaging/amqp/AMQPChannel")

/**
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  AMQPChannel,
  AMQPError.AMQPChannelError | AMQPError.AMQPConnectionError,
  Scope.Scope | AMQPConnection.AMQPConnection
> = Effect.gen(
  function*() {
    const channel = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const channelRef = yield* internal.ChannelRef.make()
        yield* internal.initiateChannel(channelRef)
        const connection = yield* AMQPConnection.AMQPConnection
        const serverProperties = yield* connection.serverProperties
        return {
          [TypeId]: TypeId as TypeId,
          connection,
          consume: (queueName: string) => internal.consume(channelRef, queueName),
          ack: (...params: Parameters<Channel["ack"]>) =>
            internal.wrapChannelMethod(channelRef, "ack", async (channel) => channel.ack(...params)),
          ackAll: (...params: Parameters<Channel["ackAll"]>) =>
            internal.wrapChannelMethod(channelRef, "ackAll", async (channel) => channel.ackAll(...params)),
          nack: (...params: Parameters<Channel["nack"]>) =>
            internal.wrapChannelMethod(channelRef, "nack", async (channel) => channel.nack(...params)),
          nackAll: (...params: Parameters<Channel["nackAll"]>) =>
            internal.wrapChannelMethod(channelRef, "nackAll", async (channel) => channel.nackAll(...params)),
          reject: (...params: Parameters<Channel["reject"]>) =>
            internal.wrapChannelMethod(channelRef, "reject", async (channel) => channel.reject(...params)),
          publish: internal.publish(channelRef, serverProperties),
          sendToQueue: (...params: Parameters<Channel["sendToQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "sendToQueue", async (channel) => channel.sendToQueue(...params)),
          assertQueue: (...params: Parameters<Channel["assertQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "assertQueue", async (channel) => channel.assertQueue(...params)),
          checkQueue: (...params: Parameters<Channel["checkQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "checkQueue", async (channel) => channel.checkQueue(...params)),
          deleteQueue: (...params: Parameters<Channel["deleteQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "deleteQueue", async (channel) => channel.deleteQueue(...params)),
          purgeQueue: (...params: Parameters<Channel["purgeQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "purgeQueue", async (channel) => channel.purgeQueue(...params)),
          bindQueue: (...params: Parameters<Channel["bindQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "bindQueue", async (channel) => channel.bindQueue(...params)),
          unbindQueue: (...params: Parameters<Channel["unbindQueue"]>) =>
            internal.wrapChannelMethod(channelRef, "unbindQueue", async (channel) => channel.unbindQueue(...params)),
          assertExchange: (...params: Parameters<Channel["assertExchange"]>) =>
            internal.wrapChannelMethod(
              channelRef,
              "assertExchange",
              async (channel) => channel.assertExchange(...params)
            ),
          checkExchange: (...params: Parameters<Channel["checkExchange"]>) =>
            internal.wrapChannelMethod(
              channelRef,
              "checkExchange",
              async (channel) => channel.checkExchange(...params)
            ),
          deleteExchange: (...params: Parameters<Channel["deleteExchange"]>) =>
            internal.wrapChannelMethod(
              channelRef,
              "deleteExchange",
              async (channel) => channel.deleteExchange(...params)
            ),
          bindExchange: (...params: Parameters<Channel["bindExchange"]>) =>
            internal.wrapChannelMethod(
              channelRef,
              "bindExchange",
              async (channel) => channel.bindExchange(...params)
            ),
          unbindExchange: (...params: Parameters<Channel["unbindExchange"]>) =>
            internal.wrapChannelMethod(
              channelRef,
              "unbindExchange",
              async (channel) => channel.unbindExchange(...params)
            ),
          cancel: (...params: Parameters<Channel["cancel"]>) =>
            internal.wrapChannelMethod(channelRef, "cancel", async (channel) => channel.cancel(...params)),
          get: (...params: Parameters<Channel["get"]>) =>
            internal.wrapChannelMethod(channelRef, "get", async (channel) => channel.get(...params)),
          prefetch: (...params: Parameters<Channel["prefetch"]>) =>
            internal.wrapChannelMethod(channelRef, "prefetch", async (channel) => channel.prefetch(...params)),
          recover: (...params: Parameters<Channel["recover"]>) =>
            internal.wrapChannelMethod(channelRef, "recover", async (channel) => channel.recover(...params)),
          close: internal.closeChannel(channelRef),
          watchChannel: internal.watchChannel(channelRef)
        }
      }),
      (channel) => channel.close
    )
    yield* Effect.forkScoped(channel.watchChannel)
    return channel
  }
)

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer: Layer.Layer<
  AMQPChannel,
  AMQPError.AMQPChannelError | AMQPError.AMQPConnectionError,
  AMQPConnection.AMQPConnection
> = Layer.scoped(AMQPChannel, make)
