/**
 * @since 0.1.0
 */
import type { Channel, GetMessage, Replies } from "amqplib"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schedule from "effect/Schedule"
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
  ) => Effect.Effect<Stream.Stream<AMQPConsumeMessage.AMQPConsumeMessage, AMQPError.AMQPChannelError>>
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

  /** @internal */
  readonly close: (config?: internal.CloseChannelOptions) => Effect.Effect<void, never, never>
}

/**
 * @category tags
 * @since 0.1.0
 */
export const AMQPChannel = Context.GenericTag<AMQPChannel>("@effect-messaging/amqp/AMQPChannel")

/**
 * @category models
 * @since 0.4.0
 */
export interface AMQPChannelOptions {
  retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPError.AMQPConnectionError>
  retryConsumptionSchedule?: Schedule.Schedule<unknown, AMQPError.AMQPChannelError>
  waitChannelTimeout?: Duration.DurationInput
}

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: AMQPChannelOptions = {}): Effect.Effect<
  AMQPChannel,
  AMQPError.AMQPChannelError | AMQPError.AMQPConnectionError,
  Scope.Scope | AMQPConnection.AMQPConnection
> =>
  Effect.gen(
    function*() {
      const internalChannel = yield* internal.InternalAMQPChannel
      const provideInternal = Effect.provideService(internal.InternalAMQPChannel, internalChannel)

      const channel = yield* Effect.acquireRelease(
        Effect.gen(function*() {
          yield* internal.initiateChannel
          const connection = yield* AMQPConnection.AMQPConnection

          return {
            [TypeId]: TypeId as TypeId,
            connection,
            consume: (queueName: string) => internal.consume(queueName).pipe(provideInternal),
            ack: (...params: Parameters<Channel["ack"]>) =>
              internal.wrapChannelMethod("ack", async (channel) => channel.ack(...params)).pipe(provideInternal),
            ackAll: (...params: Parameters<Channel["ackAll"]>) =>
              internal.wrapChannelMethod("ackAll", async (channel) => channel.ackAll(...params)).pipe(provideInternal),
            nack: (...params: Parameters<Channel["nack"]>) =>
              internal.wrapChannelMethod("nack", async (channel) => channel.nack(...params)).pipe(provideInternal),
            nackAll: (...params: Parameters<Channel["nackAll"]>) =>
              internal.wrapChannelMethod("nackAll", async (channel) => channel.nackAll(...params)).pipe(
                provideInternal
              ),
            reject: (...params: Parameters<Channel["reject"]>) =>
              internal.wrapChannelMethod("reject", async (channel) => channel.reject(...params)).pipe(provideInternal),
            publish: (...params: Parameters<Channel["publish"]>) => internal.publish(...params).pipe(provideInternal),
            sendToQueue: (...params: Parameters<Channel["sendToQueue"]>) =>
              internal.wrapChannelMethod("sendToQueue", async (channel) => channel.sendToQueue(...params)).pipe(
                provideInternal
              ),
            assertQueue: (...params: Parameters<Channel["assertQueue"]>) =>
              internal.wrapChannelMethod("assertQueue", async (channel) => channel.assertQueue(...params)).pipe(
                provideInternal
              ),
            checkQueue: (...params: Parameters<Channel["checkQueue"]>) =>
              internal.wrapChannelMethod("checkQueue", async (channel) => channel.checkQueue(...params)).pipe(
                provideInternal
              ),
            deleteQueue: (...params: Parameters<Channel["deleteQueue"]>) =>
              internal.wrapChannelMethod("deleteQueue", async (channel) => channel.deleteQueue(...params)).pipe(
                provideInternal
              ),
            purgeQueue: (...params: Parameters<Channel["purgeQueue"]>) =>
              internal.wrapChannelMethod("purgeQueue", async (channel) => channel.purgeQueue(...params)).pipe(
                provideInternal
              ),
            bindQueue: (...params: Parameters<Channel["bindQueue"]>) =>
              internal.wrapChannelMethod("bindQueue", async (channel) => channel.bindQueue(...params)).pipe(
                provideInternal
              ),
            unbindQueue: (...params: Parameters<Channel["unbindQueue"]>) =>
              internal.wrapChannelMethod("unbindQueue", async (channel) => channel.unbindQueue(...params)).pipe(
                provideInternal
              ),
            assertExchange: (...params: Parameters<Channel["assertExchange"]>) =>
              internal.wrapChannelMethod(
                "assertExchange",
                async (channel) => channel.assertExchange(...params)
              ).pipe(provideInternal),
            checkExchange: (...params: Parameters<Channel["checkExchange"]>) =>
              internal.wrapChannelMethod(
                "checkExchange",
                async (channel) => channel.checkExchange(...params)
              ).pipe(provideInternal),
            deleteExchange: (...params: Parameters<Channel["deleteExchange"]>) =>
              internal.wrapChannelMethod(
                "deleteExchange",
                async (channel) => channel.deleteExchange(...params)
              ).pipe(provideInternal),
            bindExchange: (...params: Parameters<Channel["bindExchange"]>) =>
              internal.wrapChannelMethod(
                "bindExchange",
                async (channel) => channel.bindExchange(...params)
              ).pipe(provideInternal),
            unbindExchange: (...params: Parameters<Channel["unbindExchange"]>) =>
              internal.wrapChannelMethod(
                "unbindExchange",
                async (channel) => channel.unbindExchange(...params)
              ).pipe(provideInternal),
            cancel: (...params: Parameters<Channel["cancel"]>) =>
              internal.wrapChannelMethod("cancel", async (channel) => channel.cancel(...params)).pipe(provideInternal),
            get: (...params: Parameters<Channel["get"]>) =>
              internal.wrapChannelMethod("get", async (channel) => channel.get(...params)).pipe(provideInternal),
            prefetch: (...params: Parameters<Channel["prefetch"]>) =>
              internal.wrapChannelMethod("prefetch", async (channel) => channel.prefetch(...params)).pipe(
                provideInternal
              ),
            recover: (...params: Parameters<Channel["recover"]>) =>
              internal.wrapChannelMethod("recover", async (channel) => channel.recover(...params)).pipe(
                provideInternal
              ),
            close: (opts: internal.CloseChannelOptions = {}) => internal.closeChannel(opts).pipe(provideInternal)
          }
        }),
        (channel) => channel.close()
      )
      yield* Effect.forkScoped(internal.keepChannelAlive)
      yield* Effect.forkScoped(internal.monitorChannelErrors)
      return channel
    }
  ).pipe(
    Effect.provideServiceEffect(internal.InternalAMQPChannel, internal.InternalAMQPChannel.new(options))
  )

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (options: AMQPChannelOptions = {}): Layer.Layer<
  AMQPChannel,
  AMQPError.AMQPChannelError | AMQPError.AMQPConnectionError,
  AMQPConnection.AMQPConnection
> => Layer.scoped(AMQPChannel, make(options))
