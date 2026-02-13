import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import type { Channel, ConsumeMessage } from "amqplib"
import type { StreamEmit } from "effect"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as AMQPConnection from "../AMQPConnection.js"
import type { AMQPConnectionError } from "../AMQPError.js"
import { AMQPChannelError } from "../AMQPError.js"
import { closeStream, errorStream } from "./closeStream.js"

const DEFAULT_PREFETCH = 50

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const
const ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME = "messaging.destination.subscription.name" as const
const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id" as const
const ATTR_MESSAGING_MESSAGE_CONVERSATION_ID = "messaging.message.conversation_id" as const
const ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY = "messaging.amqp.destination.routing_key" as const

/** @internal */
export class InternalAMQPChannel
  extends Context.Tag("@effect-messaging/amqp/InternalAMQPChannel")<InternalAMQPChannel, {
    channelRef: SubscriptionRef.SubscriptionRef<Option.Option<Channel>>
    serverProperties: AMQPConnection.AMQPConnectionServerProperties
    retryConnectionSchedule: Schedule.Schedule<unknown, AMQPConnectionError>
    retryConsumptionSchedule: Schedule.Schedule<unknown, AMQPChannelError>
    waitChannelTimeout: Duration.DurationInput
  }>()
{
  private static defaultRetryConnectionSchedule = Schedule.forever.pipe(Schedule.addDelay(() => 1000))
  private static defaultRetryConsumptionSchedule = Schedule.forever.pipe(Schedule.addDelay(() => 1000))
  private static defaultwaitChannelTimeout = Duration.seconds(5)

  static new = (options: {
    retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPConnectionError>
    retryConsumptionSchedule?: Schedule.Schedule<unknown, AMQPChannelError>
    waitChannelTimeout?: Duration.DurationInput
  }): Effect.Effect<
    Context.Tag.Service<InternalAMQPChannel>,
    AMQPConnectionError,
    AMQPConnection.AMQPConnection
  > =>
    Effect.gen(function*() {
      const channelRef = yield* SubscriptionRef.make(Option.none<Channel>())
      const connection = yield* AMQPConnection.AMQPConnection
      const serverProperties = yield* connection.serverProperties
      return {
        channelRef,
        serverProperties,
        retryConnectionSchedule: options.retryConnectionSchedule ?? InternalAMQPChannel.defaultRetryConnectionSchedule,
        retryConsumptionSchedule: options.retryConsumptionSchedule ??
          InternalAMQPChannel.defaultRetryConsumptionSchedule,
        waitChannelTimeout: options.waitChannelTimeout ?? InternalAMQPChannel.defaultwaitChannelTimeout
      }
    })
}

/** @internal */
const getOrWaitChannel = Effect.gen(function*() {
  const { channelRef, waitChannelTimeout } = yield* InternalAMQPChannel
  return yield* channelRef.changes.pipe(
    Stream.takeUntil(Option.isSome),
    Stream.run(Sink.last()),
    Effect.flatten,
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => Effect.dieMessage(`Should never happen: Channel should be available here`)
    ),
    Effect.timeout(waitChannelTimeout),
    Effect.catchTag("TimeoutException", () => new AMQPChannelError({ reason: "Channel is not available" }))
  )
})

/** @internal */
export const initiateChannel = Effect.gen(function*() {
  const { channelRef } = yield* InternalAMQPChannel
  yield* SubscriptionRef.updateEffect(channelRef, () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* connection.createChannel
      return Option.some(channel)
    }))
  yield* Effect.logDebug(`AMQPChannel: channel created`)
}).pipe(
  Effect.withSpan("AMQPChannel.initiateChannel")
)

/** @internal */
export interface CloseChannelOptions {
  removeAllListeners?: boolean
}

/** @internal */
export const closeChannel = ({ removeAllListeners = true }: CloseChannelOptions = {}) =>
  Effect.gen(function*() {
    const { channelRef } = yield* InternalAMQPChannel
    yield* SubscriptionRef.updateEffect(channelRef, (channel) =>
      Effect.gen(function*() {
        if (Option.isSome(channel)) {
          if (removeAllListeners) {
            channel.value.removeAllListeners()
          }
          yield* Effect.tryPromise(() => channel.value.close()).pipe(Effect.ignore)
        }
        return Option.none()
      }))
    yield* Effect.logDebug("AMQPChannel: channel closed")
  }).pipe(
    Effect.withSpan("AMQPChannel.closeChannel")
  )

/** @internal */
export const keepChannelAlive = Effect.gen(function*() {
  const { channelRef, retryConnectionSchedule } = yield* InternalAMQPChannel
  return yield* Stream.runForEach(closeStream(channelRef), (event) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPChannel: close event received: ${event}`)
      yield* closeChannel()
      yield* Effect.logDebug("AMQPChannel: reconnecting")
      yield* initiateChannel.pipe(Effect.retry(retryConnectionSchedule))
    }))
})

/** @internal */
export const monitorChannelErrors = Effect.gen(function*() {
  const { channelRef } = yield* InternalAMQPChannel
  return yield* Stream.runForEach(
    errorStream(channelRef),
    (error) => Effect.logError(`AMQPChannel: error event received - ${error}`)
  )
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
          [ATTR_MESSAGING_DESTINATION_NAME]: routingKey,
          [ATTR_MESSAGING_MESSAGE_ID]: options?.messageId,
          [ATTR_MESSAGING_MESSAGE_CONVERSATION_ID]: options?.correlationId,
          [ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY]: routingKey
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
  }).pipe(Effect.withSpan(`AMQPChannel.${methodName}`))

/** @internal */
const initiateConsumption = (
  channel: Channel,
  queueName: string,
  emit: StreamEmit.EmitOpsPush<AMQPChannelError, ConsumeMessage>,
  options?: { readonly prefetch?: number }
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: queueName
    })
    yield* Effect.tryPromise({
      try: () => channel.prefetch(options?.prefetch ?? DEFAULT_PREFETCH),
      catch: (error) =>
        new AMQPChannelError({ reason: `Failed to set prefetch on channel for queue ${queueName}`, cause: error })
    })
    yield* Effect.try({
      try: () => {
        channel.consume(queueName, async (message) => {
          if (!message) return
          emit.single(message)
        }).catch((error) => {
          emit.fail(
            new AMQPChannelError({ reason: `Consumption from queue ${queueName} ended unexpectedly`, cause: error })
          )
        })

        channel.on("close", () => {
          emit.end()
        })
      },
      catch: (error) => new AMQPChannelError({ reason: `Failed to consume from queue ${queueName}`, cause: error })
    })
    yield* Effect.logDebug(`AMQPChannel: consuming from queue ${queueName}`)
  }).pipe(
    Effect.withSpan("AMQPChannel.initiateConsumption")
  )

/** @internal */
export const consume = (queueName: string, options?: { readonly prefetch?: number }) =>
  Effect.gen(function*() {
    const { channelRef, retryConsumptionSchedule } = yield* InternalAMQPChannel
    return channelRef.changes.pipe(
      Stream.filterMap(Function.identity),
      Stream.flatMap(
        (channel) =>
          Stream.asyncPush<ConsumeMessage, AMQPChannelError>((emit) =>
            initiateConsumption(channel, queueName, emit, options).pipe(
              Effect.retry(retryConsumptionSchedule)
            )
          ),
        { concurrency: "unbounded" }
      )
    )
  })
