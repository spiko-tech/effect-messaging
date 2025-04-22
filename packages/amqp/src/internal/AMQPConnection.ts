import type { Connection, Options } from "amqplib"
import { connect } from "amqplib"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { AMQPConnectionError } from "../AMQPError.js"
import { closeStream } from "./closeStream.js"

/** @internal */
export type ConnectionUrl = Redacted.Redacted<string> | Options.Connect

/** @internal */
export class InternalAMQPConnection
  extends Context.Tag("@effect-messaging/amqp/InternalAMQPConnection")<InternalAMQPConnection, {
    connectionRef: SubscriptionRef.SubscriptionRef<Option.Option<Connection>>
    url: ConnectionUrl
  }>()
{
  static new = ({ url }: { url: ConnectionUrl }): Effect.Effect<Context.Tag.Service<InternalAMQPConnection>> =>
    Effect.all({
      connectionRef: SubscriptionRef.make(Option.none<Connection>()),
      url: Effect.succeed(url)
    })
}

/** @internal */
const getOrWaitConnection = Effect.gen(function*() {
  const { connectionRef } = yield* InternalAMQPConnection
  return yield* connectionRef.changes.pipe(
    Stream.takeUntil(Option.isSome),
    Stream.run(Sink.last()),
    Effect.flatten,
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => Effect.dieMessage(`Should never happen: Connection should be available here`)
    ),
    Effect.timeout(`5 seconds`), // @TODO: make this configurable. Putting a timeout here to avoid blocking forever if the connection is never ready
    Effect.catchTag("TimeoutException", () => new AMQPConnectionError({ reason: "Connection is not available" }))
  )
})

/** @internal */
export const initiateConnection = Effect.gen(function*() {
  const { connectionRef, url } = yield* InternalAMQPConnection
  return yield* SubscriptionRef.updateEffect(connectionRef, () =>
    Effect.gen(function*() {
      const connection = yield* Effect.tryPromise({
        try: () => connect(Redacted.isRedacted(url) ? Redacted.value(url) : url),
        catch: (error) => new AMQPConnectionError({ reason: "Failed to establish connection", cause: error })
      })
      return Option.some(connection)
    })).pipe(
      Effect.tap(() => Effect.logDebug(`AMQPConnection: connection established`)),
      Effect.tapError((error) => Effect.logError(`AMQPConnection: failed to establish connection: ${error}`)),
      Effect.withSpan("AMQPConnection.initiateConnection")
    )
})

/** @internal */
export interface CloseConnectionOptions {
  removeAllListeners?: boolean
}

/** @internal */
export const closeConnection = ({ removeAllListeners = true }: CloseConnectionOptions = {}) =>
  Effect.gen(function*() {
    const { connectionRef } = yield* InternalAMQPConnection
    return yield* SubscriptionRef.updateEffect(connectionRef, (connection) =>
      Effect.gen(function*() {
        if (Option.isSome(connection)) {
          if (removeAllListeners) {
            connection.value.removeAllListeners()
          }
          yield* Effect.tryPromise(() => connection.value.close()).pipe(Effect.ignore)
        }
        return Option.none()
      })).pipe(
        Effect.tap(() => Effect.logDebug("AMQPConnection: connection closed")),
        Effect.withSpan("AMQPConnection.closeConnection")
      )
  })

/** @internal */
const reconnect = Effect.gen(function*() {
  yield* closeConnection()
  yield* initiateConnection.pipe(
    Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
  )
})

/** @internal */
export const watchConnection = Effect.gen(function*() {
  const { connectionRef } = yield* InternalAMQPConnection
  return yield* Stream.runForEach(closeStream(connectionRef), (error) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPConnection: connection error: ${error}`)
      yield* reconnect
    }))
})

/** @internal */
export const createChannel = Effect.gen(function*() {
  const conn = yield* getOrWaitConnection
  return yield* Effect.tryPromise({
    try: () => conn.createChannel(),
    catch: (error) => new AMQPConnectionError({ reason: `Failed to create channel`, cause: error })
  })
})

/** @internal */
export const createConfirmChannel = Effect.gen(function*() {
  const conn = yield* getOrWaitConnection
  return yield* Effect.tryPromise({
    try: () => conn.createConfirmChannel(),
    catch: (error) => new AMQPConnectionError({ reason: `Failed to create ConfirmChannel`, cause: error })
  })
})

/** @internal */
export const updateSecret = (...parameters: Parameters<Connection["updateSecret"]>) =>
  Effect.gen(function*() {
    const conn = yield* getOrWaitConnection
    return yield* Effect.tryPromise({
      try: () => conn.updateSecret(...parameters),
      catch: (error) => new AMQPConnectionError({ reason: `Failed to create updateSecret`, cause: error })
    })
  })

/** @internal */
export const serverProperties = Effect.gen(function*() {
  const { url } = yield* InternalAMQPConnection
  const conn = yield* getOrWaitConnection
  return {
    ...conn.connection.serverProperties,
    hostname: Redacted.isRedacted(url) ? undefined : url.hostname,
    port: Redacted.isRedacted(url) ? undefined : url.port?.toString()
  }
})
