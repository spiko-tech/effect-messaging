import { Headers, HttpTraceContext } from "@effect/platform"
import type { Channel, ConsumeMessage } from "amqplib"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type { AMQPConnectionServerProperties } from "../AMQPConnection.js"
import { AMQPConnection } from "../AMQPConnection.js"
import { AMQPChannelError } from "../AMQPError.js"
import { errorStream } from "./errorStream.js"

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const

/** @internal */
export type ChannelRef = SubscriptionRef.SubscriptionRef<Option.Option<Channel>>
/** @internal */
export const ChannelRef = {
  make: (): Effect.Effect<ChannelRef> => SubscriptionRef.make(Option.none<Channel>())
}

/** @internal */
export const getChannel = (channelRef: ChannelRef) =>
  SubscriptionRef.get(channelRef).pipe(
    Effect.flatten,
    Effect.catchTag("NoSuchElementException", () => new AMQPChannelError({ reason: "Channel is not available" }))
  )

/** @internal */
export const initiateChannel = (channelRef: ChannelRef) =>
  SubscriptionRef.updateEffect(channelRef, () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection
      const channel = yield* connection.createChannel
      return Option.some(channel)
    })).pipe(
      Effect.tap(() => Effect.logDebug(`AMQPChannel: channel created`)),
      Effect.tapError((error) => Effect.logError(`AMQPChannel: failed to create channel: ${error}`)),
      Effect.withSpan("AMQPChannel.initiateChannel")
    )

/** @internal */
export const closeChannel = (channelRef: ChannelRef) =>
  SubscriptionRef.updateEffect(channelRef, (channel) =>
    Effect.gen(function*() {
      if (Option.isSome(channel)) {
        channel.value.removeAllListeners()
        yield* Effect.tryPromise(() => channel.value.close()).pipe(Effect.ignore)
      }
      return Option.none()
    })).pipe(
      Effect.tap(() => Effect.logDebug("AMQPChannel: channel closed")),
      Effect.withSpan("AMQPChannel.closeChannel")
    )

/** @internal */
const reconnect = (channelRef: ChannelRef) =>
  Effect.gen(function*() {
    yield* closeChannel(channelRef)
    yield* initiateChannel(channelRef).pipe(
      Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
    )
  })

/** @internal */
export const watchChannel = (channelRef: ChannelRef) =>
  Stream.runForEach(errorStream(channelRef), (error) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPChannel: channel error: ${error}`)
      yield* reconnect(channelRef)
    }))

/** @internal */
export const publish = (
  channelRef: ChannelRef,
  serverProperties: AMQPConnectionServerProperties
) =>
(
  ...[exchange, routingKey, content, options]: Parameters<Channel["publish"]>
) =>
  Effect.useSpan(
    `amqp.publish ${routingKey}`,
    {
      kind: "producer",
      captureStackTrace: false,
      attributes: {
        [ATTR_SERVER_ADDRESS]: serverProperties.host,
        [ATTR_SERVER_PORT]: serverProperties.port,
        [ATTR_MESSAGING_SYSTEM]: serverProperties.product,
        [ATTR_MESSAGING_OPERATION_NAME]: "publish",
        [ATTR_MESSAGING_OPERATION_TYPE]: "send",
        [ATTR_MESSAGING_DESTINATION_NAME]: routingKey
      }
    },
    (span) =>
      Effect.gen(function*() {
        const channel = yield* getChannel(channelRef)

        return yield* Effect.try({
          try: () =>
            channel.publish(exchange, routingKey, content, {
              ...options,
              headers: Headers.merge(
                options?.headers ?? {},
                HttpTraceContext.toHeaders(span)
              )
            }),
          catch: (error) => new AMQPChannelError({ reason: `Failed to publish on channel`, cause: error })
        })
      })
  )

/** @internal */
export const wrapChannelMethod = <A>(
  channelRef: ChannelRef,
  methodName: string,
  callMethod: (channel: Channel) => PromiseLike<A>
) =>
  Effect.gen(function*() {
    const channel = yield* getChannel(channelRef)
    return yield* Effect.tryPromise({
      try: () => callMethod(channel),
      catch: (error) => new AMQPChannelError({ reason: `Failed to call ${methodName} on channel`, cause: error })
    })
  })

/** @internal */
const initiateConsumption = (channel: Channel, queueName: string) =>
  Stream.asyncPush<ConsumeMessage, AMQPChannelError>((emit) =>
    Effect.gen(function*() {
      yield* Effect.tryPromise({
        try: () =>
          channel.consume(queueName, async (message) => {
            if (!message) return
            emit.single(message)
          }),
        catch: (error) => new AMQPChannelError({ reason: `Failed to consume from queue ${queueName}`, cause: error })
      })
    }).pipe(
      Effect.tap(() => Effect.logDebug(`AMQPChannel: consuming from queue ${queueName}`)),
      Effect.tapError((error) => Effect.logError(`AMQPChannel: error consuming from queue ${queueName}: ${error}`)),
      Effect.withSpan("AMQPChannel.initiateConsumption"),
      Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
    )
  )

/** @internal */
export const consume = (channelRef: ChannelRef, queueName: string) =>
  channelRef.changes.pipe(
    Stream.filterMap(Function.identity),
    Stream.flatMap((channel) => initiateConsumption(channel, queueName), { concurrency: "unbounded" })
  )
