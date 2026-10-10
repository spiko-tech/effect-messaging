/**
 * Optional @effect-messaging/core subscriber adapter. Handlers may finish after
 * a connection is lost; obsolete settlements never reach a replacement channel.
 * @since 0.3.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import type * as SubscriberApp from "@effect-messaging/core/SubscriberApp"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as SubscriberRunner from "@effect-messaging/core/SubscriberRunner"
import * as Effect from "effect/Effect"
import * as Headers from "effect/http/Headers"
import * as HttpTraceContext from "effect/http/HttpTraceContext"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as AMQPChannel from "./AMQPChannel.ts"
import * as AMQPConsumeMessage from "./AMQPConsumeMessage.ts"
import * as AMQPError from "./AMQPError.ts"
import type * as AMQPSubscriberResponse from "./AMQPSubscriberResponse.ts"
import type * as AMQPTopology from "./AMQPTopology.ts"
import * as DeliverySettlement from "./internal/deliverySettlement.ts"

/** @since 0.3.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPSubscriber")

/** @since 0.5.0 */
export type AMQPSubscriberApp<E, R> = SubscriberApp.SubscriberApp<
  AMQPSubscriberResponse.AMQPSubscriberResponse,
  AMQPConsumeMessage.AMQPConsumeMessage,
  E,
  R
>

/** @since 0.3.0 */
export interface AMQPSubscriber
  extends Subscriber.Subscriber<AMQPSubscriberResponse.AMQPSubscriberResponse, AMQPConsumeMessage.AMQPConsumeMessage>
{
  readonly [TypeId]: typeof TypeId
}

/** @since 0.5.0 */
export interface AMQPSubscriberOptions extends SubscriberRunner.SubscriberRunnerOptions {
  readonly concurrency?: number
}

const Concurrency = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })))

const settle = (effect: Effect.Effect<void, AMQPError.AMQPError>) =>
  effect.pipe(
    // The broker owns redelivery after session loss. Retrying an old settlement is never meaningful.
    Effect.catchTag("AMQPSettlementError", () => Effect.void)
  )

const subscribe = (
  channel: AMQPChannel.AMQPChannel,
  queue: AMQPTopology.QueueName,
  concurrency: number,
  options: AMQPSubscriberOptions
) =>
<E, R>(app: AMQPSubscriberApp<E, R>) =>
  Effect.gen(function*() {
    const messages = yield* channel.consume(queue, { prefetch: concurrency })
    const permits = yield* Semaphore.make(concurrency)
    const handlerScope = yield* Scope.make()
    return yield* Stream.runForEach(messages, (message) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          yield* restore(permits.take(1))
          // A delivery can outlive its session while waiting outside the native mailbox for this permit.
          if (!DeliverySettlement.isActive(message)) {
            yield* permits.release(1)
            return
          }
          const headers = message.properties.headers
          const traceparent = headers?.traceparent
          const tracestate = headers?.tracestate
          const traceHeaders = {
            ...(typeof traceparent === "string" ? { traceparent } : {}),
            ...(typeof tracestate === "string" ? { tracestate } : {})
          }
          yield* SubscriberRunner.runStream(Stream.succeed(message), {
            name: "AMQPSubscriber",
            spanName: (delivery) =>
              `amqp.consume ${delivery.fields.routingKey}`,
            parentSpan: () => Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(traceHeaders))),
            spanAttributes: (delivery) => ({
              "messaging.system": "rabbitmq",
              "messaging.operation.type": "process",
              "messaging.destination.name": typeof queue === "string" ? queue : queue.queue,
              "messaging.destination.subscription.name": delivery.fields.consumerTag,
              "messaging.amqp.destination.routing_key": delivery.fields.routingKey,
              "messaging.amqp.message.delivery_tag": delivery.fields.deliveryTag.toString(),
              "messaging.message.id": delivery.properties.messageId,
              "messaging.message.conversation_id": delivery.properties.correlationId
            }),
            handler: (delivery) => Effect.provide(app, AMQPConsumeMessage.layer(delivery)),
            options,
            onSuccess: (delivery, span) => (response) => {
              switch (response._tag) {
                case "Ack":
                  span.attribute("messaging.operation.name", "ack")
                  return settle(channel.ack(delivery))
                case "Nack":
                  span.attribute("messaging.operation.name", "nack")
                  return settle(channel.nack(delivery, response.allUpTo, response.requeue))
                case "Reject":
                  span.attribute("messaging.operation.name", "reject")
                  return settle(channel.reject(delivery, response.requeue))
              }
            },
            onError: (delivery, span) => () => {
              span.attribute("messaging.operation.name", "nack")
              return settle(channel.nack(delivery, false, false))
            }
          }).pipe(
            Effect.ensuring(permits.release(1)),
            Effect.forkIn(handlerScope)
          )
        })
      )).pipe(
        Effect.onExit((exit) =>
          Scope.close(handlerScope, exit)
        )
      )
  }).pipe(
    Effect.mapError((cause) =>
      new SubscriberError.SubscriberError({ reason: "AMQPSubscriber failed to subscribe", cause })
    )
  )

/** @since 0.3.0 */
export const make = (
  queue: AMQPTopology.QueueName,
  options: AMQPSubscriberOptions = {}
): Effect.Effect<AMQPSubscriber, AMQPError.AMQPError, AMQPChannel.AMQPChannel> =>
  Effect.gen(function*() {
    const channel = yield* AMQPChannel.AMQPChannel
    const concurrency = yield* Schema.decodeUnknownEffect(Concurrency)(options.concurrency ?? 50).pipe(
      Effect.mapError((cause) => new AMQPError.AMQPChannelError({ reason: "Invalid subscriber concurrency", cause }))
    )
    return {
      [TypeId]: TypeId,
      [Subscriber.TypeId]: Subscriber.TypeId,
      subscribe: subscribe(channel, queue, concurrency, options),
      healthCheck: channel.checkQueue(queue).pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          new SubscriberError.SubscriberError({ reason: "AMQPSubscriber healthcheck failed", cause })
        )
      )
    }
  })
