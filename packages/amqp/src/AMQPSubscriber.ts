/**
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import type * as SubscriberApp from "@effect-messaging/core/SubscriberApp"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as Headers from "@effect/platform/Headers"
import * as HttpTraceContext from "@effect/platform/HttpTraceContext"
import type { Options } from "amqplib"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Function from "effect/Function"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import * as AMQPChannel from "./AMQPChannel.js"
import type * as AMQPConnection from "./AMQPConnection.js"
import * as AMQPConsumeMessage from "./AMQPConsumeMessage.js"
import type * as AMQPError from "./AMQPError.js"
import type * as AMQPSubscriberResponse from "./AMQPSubscriberResponse.js"

/**
 * @category type ids
 * @since 0.3.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPSubscriber")

/**
 * @category type ids
 * @since 0.3.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPPublishMessage {
  exchange: string
  routingKey: string
  content: Buffer
  options?: Options.Publish
}

/**
 * @category models
 * @since 0.5.0
 */
export type AMQPSubscriberApp<E, R> = SubscriberApp.SubscriberApp<
  AMQPSubscriberResponse.AMQPSubscriberResponse,
  AMQPConsumeMessage.AMQPConsumeMessage,
  E,
  R
>

/**
 * @category models
 * @since 0.3.0
 */
export interface AMQPSubscriber
  extends Subscriber.Subscriber<AMQPSubscriberResponse.AMQPSubscriberResponse, AMQPConsumeMessage.AMQPConsumeMessage>
{
  readonly [TypeId]: TypeId
}

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_DESTINATION_NAME = "messaging.destination.name" as const
const ATTR_MESSAGING_OPERATION_NAME = "messaging.operation.name" as const
const ATTR_MESSAGING_OPERATION_TYPE = "messaging.operation.type" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const
const ATTR_MESSAGING_MESSAGE_ID = "messaging.message.id" as const
const ATTR_MESSAGING_MESSAGE_CONVERSATION_ID = "messaging.message.conversation_id" as const
const ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY = "messaging.amqp.destination.routing_key" as const
const ATTR_MESSAGING_AMQP_MESSAGE_DELIVERY_TAG = "messaging.amqp.message.delivery_tag" as const
const ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME = "messaging.destination.subscription.name" as const

/** @internal */
const subscribe = (
  channel: AMQPChannel.AMQPChannel,
  queueName: string,
  connectionProperties: AMQPConnection.AMQPConnectionServerProperties,
  options: AMQPSubscriberOptions
) =>
<E, R>(app: AMQPSubscriberApp<E, R>) =>
  Effect.gen(function*() {
    const fiberSet = yield* FiberSet.make<void>()

    // When handlers are uninterruptible, wait for all in-flight message
    // handlers to finish their ack/nack before allowing the channel to close.
    // When handlers are interruptible (default), skip the drain and let
    // handlers be interrupted for fast shutdown (messages will be redelivered).
    if (options.uninterruptible) {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* Effect.logDebug("AMQPSubscriber: draining in-flight handlers")
          if (options.drainTimeout) {
            // Finalizers run in an uninterruptible context, so Effect.timeout
            // (which relies on interruption) does not work here. Instead, fork
            // two independent daemon fibers – one that waits for in-flight
            // handlers and one that sleeps for the drain timeout – and race
            // them through a shared Deferred. Daemon fibers are used so they
            // don't block scope cleanup when the finalizer returns.
            const done = yield* Deferred.make<void>()
            yield* Effect.forkDaemon(
              FiberSet.awaitEmpty(fiberSet).pipe(
                Effect.andThen(Deferred.succeed(done, undefined))
              )
            )
            yield* Effect.forkDaemon(
              Effect.sleep(options.drainTimeout).pipe(
                Effect.andThen(Deferred.succeed(done, undefined))
              )
            )
            yield* Deferred.await(done)
          } else {
            yield* FiberSet.awaitEmpty(fiberSet)
          }
          yield* Effect.logDebug("AMQPSubscriber: all in-flight handlers drained")
        })
      )
    }

    const consumeStream = yield* channel.consume(
      queueName,
      options.concurrency ? { prefetch: options.concurrency } : undefined
    )
    return yield* consumeStream.pipe(
      Stream.runForEach((message) =>
        FiberSet.run(
          fiberSet,
          Effect.useSpan(
            `amqp.consume ${message.fields.routingKey}`,
            {
              parent: Option.getOrUndefined(
                HttpTraceContext.fromHeaders(Headers.fromInput(message.properties.headers))
              ),
              kind: "consumer",
              captureStackTrace: false,
              attributes: {
                [ATTR_SERVER_ADDRESS]: connectionProperties.host,
                [ATTR_SERVER_PORT]: connectionProperties.port,
                [ATTR_MESSAGING_MESSAGE_ID]: message.properties.messageId,
                [ATTR_MESSAGING_MESSAGE_CONVERSATION_ID]: message.properties.correlationId,
                [ATTR_MESSAGING_SYSTEM]: connectionProperties.product,
                [ATTR_MESSAGING_DESTINATION_SUBSCRIPTION_NAME]: queueName,
                [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
                [ATTR_MESSAGING_OPERATION_TYPE]: "receive",
                [ATTR_MESSAGING_AMQP_DESTINATION_ROUTING_KEY]: message.fields.routingKey,
                [ATTR_MESSAGING_AMQP_MESSAGE_DELIVERY_TAG]: message.fields.deliveryTag
              }
            },
            (span) =>
              Effect.gen(function*() {
                yield* Effect.logDebug(`amqp.consume ${message.fields.routingKey}`)
                const response = yield* (
                  options.uninterruptible && options.handlerTimeout
                    // Effect.timeoutFail relies on interruption internally,
                    // which does not work inside Effect.uninterruptible. Use a
                    // Deferred-based race instead: fork the app in an
                    // interruptible region so the timeout can interrupt it.
                    ? Effect.gen(function*() {
                      const appFiber = yield* Effect.fork(Effect.interruptible(app))
                      const timerFiber = yield* Effect.fork(
                        Effect.sleep(options.handlerTimeout!).pipe(
                          Effect.andThen(Fiber.interrupt(appFiber))
                        )
                      )
                      return yield* Fiber.join(appFiber).pipe(
                        Effect.onExit(() => Fiber.interrupt(timerFiber)),
                        Effect.mapErrorCause((cause) =>
                          Cause.isInterruptedOnly(cause)
                            ? Cause.fail(
                              new SubscriberError.SubscriberError({
                                reason: `AMQPSubscriber: handler timed out`
                              }) as E & SubscriberError.SubscriberError
                            )
                            : cause
                        )
                      )
                    })
                    : app.pipe(
                      options.handlerTimeout
                        ? Effect.timeoutFail({
                          duration: options.handlerTimeout,
                          onTimeout: () =>
                            new SubscriberError.SubscriberError({ reason: `AMQPSubscriber: handler timed out` })
                        })
                        : Function.identity
                    )
                )
                yield* Match.valueTags(response, {
                  Ack: () =>
                    Effect.gen(function*() {
                      span.attribute(ATTR_MESSAGING_OPERATION_NAME, "ack")
                      yield* channel.ack(message)
                    }),
                  Nack: (r) =>
                    Effect.gen(function*() {
                      span.attribute(ATTR_MESSAGING_OPERATION_NAME, "nack")
                      yield* channel.nack(message, r.allUpTo, r.requeue)
                    }),
                  Reject: (r) =>
                    Effect.gen(function*() {
                      span.attribute(ATTR_MESSAGING_OPERATION_NAME, "reject")
                      yield* channel.reject(message, r.requeue)
                    })
                })
              }).pipe(
                Effect.provide(AMQPConsumeMessage.layer(message)),
                Effect.tapErrorCause((cause) =>
                  Effect.gen(function*() {
                    yield* Effect.logError(Cause.pretty(cause))
                    span.attribute(ATTR_MESSAGING_OPERATION_NAME, "nack")
                    span.attribute(
                      "error.type",
                      String(Cause.squashWith(
                        cause,
                        (_) => Predicate.hasProperty(_, "_tag") ? _._tag : _ instanceof Error ? _.name : `${_}`
                      ))
                    )
                    span.attribute("error.stack", Cause.pretty(cause))
                    span.attribute(
                      "error.message",
                      String(Cause.squashWith(
                        cause,
                        (_) => Predicate.hasProperty(_, "reason") ? _.reason : _ instanceof Error ? _.message : `${_}`
                      ))
                    )
                    yield* channel.nack(message, false, false)
                  })
                ),
                options.uninterruptible ? Effect.uninterruptible : Effect.interruptible,
                options.uninterruptible && options.drainTimeout ? Effect.disconnect : Function.identity,
                Effect.withParentSpan(span),
                Effect.catchAllCause(() => Effect.void)
              )
          )
        ).pipe(Effect.asVoid)
      ),
      Effect.mapError((error) =>
        new SubscriberError.SubscriberError({ reason: `AMQPSubscriber failed to subscribe`, cause: error })
      )
    )
  }).pipe(Effect.scoped)

/** @internal */
const healthCheck = (
  channel: AMQPChannel.AMQPChannel,
  queueName: string
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  channel.checkQueue(queueName).pipe(
    Effect.catchTag("AMQPChannelError", (error) =>
      new SubscriberError.SubscriberError({ reason: `Healthcheck failed`, cause: error })),
    Effect.asVoid
  )

/**
 * @category models
 * @since 0.5.0
 */
export interface AMQPSubscriberOptions {
  uninterruptible?: boolean
  handlerTimeout?: Duration.DurationInput
  drainTimeout?: Duration.DurationInput
  concurrency?: number
}

/**
 * @category constructors
 * @since 0.3.0
 */
export const make = (
  queueName: string,
  options: AMQPSubscriberOptions = {}
): Effect.Effect<
  AMQPSubscriber,
  AMQPError.AMQPConnectionError,
  AMQPChannel.AMQPChannel
> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel
    const serverProperties = yield* channel.connection.serverProperties

    const subscriber: AMQPSubscriber = {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(channel, queueName, serverProperties, options),
      healthCheck: healthCheck(channel, queueName)
    }

    return subscriber
  })
