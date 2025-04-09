import type { Channel, ConsumeMessage } from "amqplib"
import { Effect, identity, Option, Schedule, Stream, SubscriptionRef } from "effect"
import { AMQPConnection } from "../AMQPConnection.js"
import { AMQPChannelError } from "../AMQPError.js"
import { errorStream } from "./errorStream.js"

export type ChannelRef = SubscriptionRef.SubscriptionRef<Option.Option<Channel>>
export const ChannelRef = {
  make: (): Effect.Effect<ChannelRef> => SubscriptionRef.make(Option.none<Channel>())
}

export const getChannel = (channelRef: ChannelRef) =>
  SubscriptionRef.get(channelRef).pipe(
    Effect.flatten,
    Effect.catchTag("NoSuchElementException", () => new AMQPChannelError({ reason: "Channel is not available" }))
  )

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

const reconnect = (channelRef: ChannelRef) =>
  Effect.gen(function*() {
    yield* closeChannel(channelRef)
    yield* initiateChannel(channelRef).pipe(
      Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
    )
  })

export const watchChannel = (channelRef: ChannelRef) =>
  Stream.runForEach(errorStream(channelRef), (error) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPChannel: channel error: ${error}`)
      yield* reconnect(channelRef)
    }))

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

export const consume = (channelRef: ChannelRef, queueName: string) =>
  channelRef.changes.pipe(
    Stream.filterMap(identity),
    Stream.flatMap((channel) => initiateConsumption(channel, queueName), { concurrency: "unbounded" })
  )
