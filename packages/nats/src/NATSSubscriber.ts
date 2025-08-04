/**
 * @since 0.1.0
 */
import * as Subscriber from "@effect-messaging/core/Subscriber"
import * as SubscriberError from "@effect-messaging/core/SubscriberError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { SubscriptionOptions } from "nats"
import * as NATSConnection from "./NATSConnection.js"
import * as NATSMessage from "./NATSMessage.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSSubscriber")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSSubscriber extends Subscriber.Subscriber<NATSMessage.NATSMessage> {
  readonly [TypeId]: TypeId
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSSubscriber = Context.GenericTag<NATSSubscriber>("@effect-messaging/nats/NATSSubscriber")

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSSubscriberConfig {
  readonly subject: string
  readonly options?: SubscriptionOptions
}

/** @internal */
const subscribe = (
  connection: NATSConnection.NATSConnection,
  config: NATSSubscriberConfig
) =>
<E, R>(
  handler: Effect.Effect<void, E, R | NATSMessage.NATSMessage>
): Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, NATSMessage.NATSMessage>> =>
  Effect.scoped(
    Effect.gen(function*() {
      const subscription = connection.connection.subscribe(config.subject, config.options)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (!subscription.isClosed()) {
            subscription.unsubscribe()
          }
        })
      )

      return yield* Effect.async<void, SubscriberError.SubscriberError>((resume) => {
        const processMessages = async () => {
          try {
            for await (const msg of subscription) {
              const natsMessage = NATSMessage.make(msg)
              // Fire and forget message processing to avoid blocking
              Effect.runFork(
                (Effect.provide(
                  handler,
                  NATSMessage.layer(natsMessage)
                ) as Effect.Effect<void, never, never>).pipe(
                  Effect.catchAll((error) => Effect.logError(`Failed to process NATS message: ${error}`))
                )
              )
            }
            resume(Effect.void)
          } catch (error) {
            resume(
              Effect.fail(
                new SubscriberError.SubscriberError({
                  reason: `NATS subscription failed: ${error}`,
                  cause: error
                })
              )
            )
          }
        }

        processMessages()

        return Effect.sync(() => {
          if (!subscription.isClosed()) {
            subscription.unsubscribe()
          }
        })
      })
    })
  ).pipe(
    Effect.catchAll((error) =>
      Effect.fail(
        new SubscriberError.SubscriberError({
          reason: `Failed to create NATS subscription: ${error}`,
          cause: error
        })
      )
    )
  ) as Effect.Effect<void, SubscriberError.SubscriberError, Exclude<R, NATSMessage.NATSMessage>>

/** @internal */
const healthCheck = (
  connection: NATSConnection.NATSConnection
): Effect.Effect<void, SubscriberError.SubscriberError, never> =>
  Effect.gen(function*() {
    if (NATSConnection.isClosed(connection)) {
      yield* Effect.fail(
        new SubscriberError.SubscriberError({
          reason: "NATS connection is closed"
        })
      )
    }
  })

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  connection: NATSConnection.NATSConnection,
  config: NATSSubscriberConfig
): NATSSubscriber => ({
  [TypeId]: TypeId,
  [Subscriber.TypeId]: Subscriber.TypeId,
  subscribe: subscribe(connection, config),
  healthCheck: healthCheck(connection)
})

/**
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: NATSSubscriberConfig
): Layer.Layer<NATSSubscriber, never, NATSConnection.NATSConnection> =>
  Layer.effect(
    NATSSubscriber,
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      return make(connection, config)
    })
  )
