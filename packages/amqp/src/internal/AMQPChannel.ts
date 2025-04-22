import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import type { Channel, ConsumeMessage } from "amqplib"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as AMQPConnection from "../AMQPConnection.js"
import { AMQPChannelError } from "../AMQPError.js"
import { closeStream } from "./closeStream.js"

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const

/** @internal */
export class InternalAMQPChannel
  extends Context.Tag("@effect-messaging/amqp/InternalAMQPChannel")<InternalAMQPChannel, {
    channelRef: SubscriptionRef.SubscriptionRef<Option.Option<Channel>>
    serverProperties: AMQPConnection.AMQPConnectionServerProperties
  }>()
{
  static new = () =>
    Effect.gen(function*() {
      const channelRef = yield* SubscriptionRef.make(Option.none<Channel>())
      const connection = yield* AMQPConnection.AMQPConnection
      const serverProperties = yield* connection.serverProperties
      return { channelRef, serverProperties }
    })
}

/** @internal */
const getOrWaitChannel = Effect.gen(function*() {
  const { channelRef } = yield* InternalAMQPChannel
  return yield* channelRef.changes.pipe(
    Stream.takeUntil(Option.isSome),
    Stream.run(Sink.last()),
    Effect.flatten,
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => Effect.dieMessage(`Should never happen: Channel should be available here`)
    ),
    Effect.timeout(`5 seconds`), // @TODO: make this configurable. Putting a timeout here to avoid blocking forever if the channel is never ready
    Effect.catchTag("TimeoutException", () => new AMQPChannelError({ reason: "Channel is not available" }))
  )
})

/** @internal */
export const initiateChannel = Effect.gen(function*() {
  const { channelRef } = yield* InternalAMQPChannel
  return yield* SubscriptionRef.updateEffect(channelRef, () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* connection.createChannel
      return Option.some(channel)
    })).pipe(
      Effect.tap(() => Effect.logDebug(`AMQPChannel: channel created`)),
      Effect.tapError((error) => Effect.logError(`AMQPChannel: failed to create channel: ${error}`)),
      Effect.withSpan("AMQPChannel.initiateChannel")
    )
})

/** @internal */
export interface CloseChannelOptions {
  removeAllListeners?: boolean
}

/** @internal */
export const closeChannel = ({ removeAllListeners = true }: CloseChannelOptions = {}) =>
  Effect.gen(function*() {
    const { channelRef } = yield* InternalAMQPChannel
    return yield* SubscriptionRef.updateEffect(channelRef, (channel) =>
      Effect.gen(function*() {
        if (Option.isSome(channel)) {
          if (removeAllListeners) {
            channel.value.removeAllListeners()
          }
          yield* Effect.tryPromise(() => channel.value.close()).pipe(Effect.ignore)
        }
        return Option.none()
      })).pipe(
        Effect.tap(() => Effect.logDebug("AMQPChannel: channel closed")),
        Effect.withSpan("AMQPChannel.closeChannel")
      )
  })

/** @internal */
const reconnect = Effect.gen(function*() {
  yield* closeChannel()
  yield* initiateChannel.pipe(
    Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
  )
})

/** @internal */
export const watchChannel = Effect.gen(function*() {
  const { channelRef } = yield* InternalAMQPChannel
  return yield* Stream.runForEach(closeStream(channelRef), (error) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPChannel: channel error: ${error}`)
      yield* reconnect
    }))
})

/** @internal */
export const publish = (
  ...[exchange, routingKey, content, options]: Parameters<Channel["publish"]>
) =>
  Effect.gen(function*() {
    const { serverProperties } = yield* InternalAMQPChannel
    return yield* Effect.useSpan(
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
          const channel = yield* getOrWaitChannel
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
  })

/** @internal */
export const wrapChannelMethod = <A>(
  methodName: string,
  callMethod: (channel: Channel) => PromiseLike<A>
) =>
  Effect.gen(function*() {
    const channel = yield* getOrWaitChannel
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
export const consume = (queueName: string) =>
  Effect.gen(function*() {
    const { channelRef } = yield* InternalAMQPChannel
    return channelRef.changes.pipe(
      Stream.filterMap(Function.identity),
      Stream.flatMap((channel) => initiateConsumption(channel, queueName), { concurrency: "unbounded" })
    )
  })
