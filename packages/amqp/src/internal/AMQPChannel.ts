import type { Channel, ConfirmChannel, ConsumeMessage } from "amqplib"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Headers from "effect/http/Headers"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as AMQPConnection from "../AMQPConnection.ts"
import type { AMQPConnectionError } from "../AMQPError.ts"
import { AMQPChannelError } from "../AMQPError.ts"
import { closeStream, errorStream, resourceStates, trackResource } from "./closeStream.ts"

const DEFAULT_PREFETCH = 50

// Interrupt the detached work asynchronously so a timeout does not wait for its finalizers.
const disconnect = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.forkDetach(self), (fiber) =>
    Fiber.join(fiber).pipe(
      Effect.onInterrupt(() => Effect.forkDetach(Fiber.interrupt(fiber)).pipe(Effect.asVoid))
    ))

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
export const InternalAMQPChannel = Context.Service<{
  channelRef: SubscriptionRef.SubscriptionRef<Option.Option<Channel>>
  serverProperties: AMQPConnection.AMQPConnectionServerProperties
  retryConnectionSchedule: Schedule.Schedule<unknown, AMQPConnectionError>
  retryConsumptionSchedule: Schedule.Schedule<unknown, AMQPChannelError>
  waitChannelTimeout: Duration.Input
  confirm: boolean
  confirmTimeout: Duration.Input
}>("@effect-messaging/amqp/InternalAMQPChannel")

const defaultRetryConnectionSchedule = Schedule.spaced(1000)
const defaultRetryConsumptionSchedule = Schedule.spaced(1000)
const defaultWaitChannelTimeout = Duration.seconds(5)
const defaultConfirmTimeout = Duration.seconds(30)

export const makeInternalAMQPChannel = (options: {
  retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPConnectionError>
  retryConsumptionSchedule?: Schedule.Schedule<unknown, AMQPChannelError>
  waitChannelTimeout?: Duration.Input
  confirm?: boolean
  confirmTimeout?: Duration.Input
}): Effect.Effect<
  Context.Service.Shape<typeof InternalAMQPChannel>,
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
      retryConnectionSchedule: options.retryConnectionSchedule ?? defaultRetryConnectionSchedule,
      retryConsumptionSchedule: options.retryConsumptionSchedule ?? defaultRetryConsumptionSchedule,
      waitChannelTimeout: options.waitChannelTimeout ?? defaultWaitChannelTimeout,
      confirm: options.confirm ?? false,
      confirmTimeout: options.confirmTimeout ?? defaultConfirmTimeout
    }
  })

/** @internal */
const getOrWaitChannel = Effect.gen(function*() {
  const { channelRef, waitChannelTimeout } = yield* InternalAMQPChannel
  return yield* SubscriptionRef.changes(channelRef).pipe(
    Stream.filter(Option.isSome),
    Stream.map((channel) => channel.value),
    Stream.filter((channel) => !resourceStates.has(channel)),
    Stream.take(1),
    Stream.run(Sink.last()),
    Effect.flatMap(Option.match({
      onNone: () => Effect.die(new Error("Should never happen: Channel should be available here")),
      onSome: Effect.succeed
    })),
    Effect.timeout(waitChannelTimeout),
    Effect.catchTag("TimeoutError", () => new AMQPChannelError({ reason: "Channel is not available" }))
  )
})

/** @internal */
export const initiateChannel = Effect.gen(function*() {
  const { channelRef, confirm } = yield* InternalAMQPChannel
  yield* SubscriptionRef.updateEffect(channelRef, () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const channel = yield* confirm ? connection.createConfirmChannel : connection.createChannel
      return Option.some(trackResource(channel))
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
export const closeChannel = Effect.fn("AMQPChannel.closeChannel")(function*(
  { removeAllListeners = true }: CloseChannelOptions = {}
) {
  const { channelRef, confirm, confirmTimeout } = yield* InternalAMQPChannel
  yield* SubscriptionRef.updateEffect(channelRef, (channel) =>
    Effect.gen(function*() {
      if (Option.isSome(channel)) {
        const unavailable = resourceStates.has(channel.value)
        if (removeAllListeners) {
          resourceStates.set(channel.value, "shutdown")
        }
        if (confirm && !unavailable) {
          // `removeAllListeners` also removes amqplib's own ack/nack listeners, so drain confirms first
          yield* Effect.tryPromise(() => (channel.value as ConfirmChannel).waitForConfirms()).pipe(
            disconnect, // finalizers are uninterruptible: without this the timeout could not fire
            Effect.timeout(confirmTimeout),
            Effect.ignore
          )
        }
        if (removeAllListeners) {
          channel.value.removeAllListeners()
        }
        yield* Effect.tryPromise(() => channel.value.close()).pipe(Effect.ignore)
      }
      return Option.none()
    }))
  yield* Effect.logDebug("AMQPChannel: channel closed")
})

/** @internal */
const discardChannel = (channel: Channel) =>
  Effect.gen(function*() {
    const { channelRef } = yield* InternalAMQPChannel
    yield* SubscriptionRef.updateEffect(channelRef, (current) =>
      Option.isSome(current) && current.value === channel
        ? Effect.tryPromise(() => channel.close()).pipe(Effect.ignore, Effect.as(Option.none()))
        : Effect.succeed(current))
  })

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
const publishError = (error: unknown) => new AMQPChannelError({ reason: `Failed to publish on channel`, cause: error })

// amqplib only tells a nack from a close through the error message
const confirmReasons: Record<string, string> = {
  "message nacked": "Broker nacked message",
  "channel closed": "Channel closed before confirm"
}

/** @internal */
const confirmError = (error: Error) =>
  new AMQPChannelError({ reason: confirmReasons[error.message] ?? "Broker did not confirm message", cause: error })

/** @internal */
const publishAndConfirm = (
  channel: ConfirmChannel,
  ...[exchange, routingKey, content, options]: Parameters<Channel["publish"]>
): Effect.Effect<boolean, AMQPChannelError, Context.Service.Identifier<typeof InternalAMQPChannel>> =>
  Effect.gen(function*() {
    const internalChannel = yield* InternalAMQPChannel
    const { confirmTimeout } = internalChannel
    return yield* Effect.callback<boolean, AMQPChannelError>((resume) => {
      let accepted = true // declared before `publish` so an orphaned callback never reads it uninitialized
      try {
        accepted = channel.publish(
          exchange,
          routingKey,
          content,
          options,
          (error) => resume(error ? Effect.fail(confirmError(error)) : Effect.succeed(accepted))
        )
      } catch (error) {
        // amqplib queued the callback before throwing, leaving a tagless slot in its confirm window:
        // every later ack would be attributed one message early, so the channel is unusable
        resume(
          discardChannel(channel).pipe(
            Effect.provideService(InternalAMQPChannel, internalChannel),
            Effect.andThen(Effect.fail(publishError(error)))
          )
        )
      }
    }).pipe(
      disconnect,
      Effect.timeout(confirmTimeout),
      Effect.catchTag("TimeoutError", () => new AMQPChannelError({ reason: "Timed out waiting for broker confirm" }))
    )
  })

/** @internal */
export const publish = (
  ...[exchange, routingKey, content, options]: Parameters<Channel["publish"]>
): Effect.Effect<boolean, AMQPChannelError, Context.Service.Identifier<typeof InternalAMQPChannel>> =>
  Effect.gen(function*() {
    const { confirm, serverProperties } = yield* InternalAMQPChannel
    return yield* Effect.useSpan(
      `amqp.publish ${routingKey}`,
      {
        kind: "producer",
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
          const finalOptions = {
            ...options,
            headers: Headers.merge(
              options?.headers ?? {},
              HttpTraceContext.toHeaders(span)
            )
          }
          return yield* confirm
            ? publishAndConfirm(channel as ConfirmChannel, exchange, routingKey, content, finalOptions)
            : Effect.try({
              try: () => channel.publish(exchange, routingKey, content, finalOptions),
              catch: publishError
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
const initiateConsumption = Effect.fn("initiateConsumption")(
  function*(
    channel: Channel,
    queueName: string,
    queue: Queue.Queue<ConsumeMessage, AMQPChannelError | Cause.Done>,
    options?: { readonly prefetch?: number }
  ) {
    yield* Effect.annotateCurrentSpan({
      [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: queueName
    })
    yield* Effect.tryPromise({
      try: () => channel.prefetch(options?.prefetch ?? DEFAULT_PREFETCH),
      catch: (error) =>
        new AMQPChannelError({ reason: `Failed to set prefetch on channel for queue ${queueName}`, cause: error })
    })
    const { consumerTag } = yield* Effect.tryPromise({
      try: () =>
        channel.consume(queueName, (message) => {
          if (!message) return
          Queue.offerUnsafe(queue, message)
        }),
      catch: (error) => new AMQPChannelError({ reason: `Failed to consume from queue ${queueName}`, cause: error })
    })
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => channel.cancel(consumerTag)).pipe(
        Effect.tap(Effect.logDebug(`AMQPChannel: consumer ${consumerTag} cancelled for queue ${queueName}`)),
        Effect.ignore
      )
    )
    channel.on("close", () => {
      Queue.endUnsafe(queue)
    })
    yield* Effect.logDebug(`AMQPChannel: consuming from queue ${queueName} with consumer tag ${consumerTag}`)
  },
  Effect.withSpan("AMQPChannel.initiateConsumption")
)

/** @internal */
export const consume = (queueName: string, options?: { readonly prefetch?: number }) =>
  Effect.gen(function*() {
    const { channelRef, retryConsumptionSchedule } = yield* InternalAMQPChannel
    return SubscriptionRef.changes(channelRef).pipe(
      Stream.filter(Option.isSome),
      Stream.map((channel) => channel.value),
      Stream.filter((channel) => !resourceStates.has(channel)),
      Stream.flatMap(
        (channel) =>
          Stream.callback<ConsumeMessage, AMQPChannelError>((queue) =>
            initiateConsumption(channel, queueName, queue, options).pipe(
              Effect.retry(retryConsumptionSchedule),
              Effect.catch((error) => Queue.fail(queue, error))
            )
          ),
        { concurrency: "unbounded" }
      )
    )
  })
