import type { ChannelModel, Options } from "amqplib"
import { connect } from "amqplib"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { AMQPConnectionError } from "../AMQPError.js"
import { closeStream, errorStream } from "./closeStream.js"

const ATTR_SERVER_ADDRESS = "server.address" as const
const ATTR_SERVER_PORT = "server.port" as const
const ATTR_MESSAGING_SYSTEM = "messaging.system" as const

/** @internal */
export type ConnectionUrl = Redacted.Redacted<string> | Options.Connect

export class InternalAMQPConnection
  extends Context.Tag("@effect-messaging/amqp/InternalAMQPConnection")<InternalAMQPConnection, {
    connectionRef: SubscriptionRef.SubscriptionRef<Option.Option<ChannelModel>>
    url: ConnectionUrl
    retryConnectionSchedule: Schedule.Schedule<unknown, AMQPConnectionError>
    waitConnectionTimeout: Duration.DurationInput
  }>()
{
  private static defaultRetryConnectionSchedule = Schedule.forever.pipe(Schedule.addDelay(() => 1000))
  private static defaultWaitConnectionTimeout = Duration.seconds(5)

  static new = (
    url: ConnectionUrl,
    options: {
      retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPConnectionError>
      waitConnectionTimeout?: Duration.DurationInput
    }
  ): Effect.Effect<Context.Tag.Service<InternalAMQPConnection>> =>
    Effect.gen(function*() {
      const connectionRef = yield* SubscriptionRef.make(Option.none<ChannelModel>())
      return {
        connectionRef,
        url,
        retryConnectionSchedule: options.retryConnectionSchedule ??
          InternalAMQPConnection.defaultRetryConnectionSchedule,
        waitConnectionTimeout: options.waitConnectionTimeout ?? InternalAMQPConnection.defaultWaitConnectionTimeout
      }
    })
}

/** @internal */
const getOrWaitConnection = Effect.gen(function*() {
  const { connectionRef, waitConnectionTimeout } = yield* InternalAMQPConnection
  return yield* connectionRef.changes.pipe(
    Stream.takeUntil(Option.isSome),
    Stream.run(Sink.last()),
    Effect.flatten,
    Effect.flatten,
    Effect.catchTag(
      "NoSuchElementException",
      () => Effect.dieMessage(`Should never happen: Connection should be available here`)
    ),
    Effect.timeout(waitConnectionTimeout),
    Effect.catchTag("TimeoutException", () => new AMQPConnectionError({ reason: "Connection is not available" }))
  )
})

/** @internal */
const annotateSpanWithConnectionProps = (conn: ChannelModel) =>
  Effect.annotateCurrentSpan({
    [ATTR_SERVER_ADDRESS]: conn.connection.serverProperties.host,
    [ATTR_SERVER_PORT]: conn.connection.serverProperties.port,
    [ATTR_MESSAGING_SYSTEM]: conn.connection.serverProperties.product
  })

/** @internal */
export const initiateConnection = Effect.gen(function*() {
  const { connectionRef, url } = yield* InternalAMQPConnection
  yield* Effect.annotateCurrentSpan({ url })
  yield* SubscriptionRef.updateEffect(connectionRef, () =>
    Effect.gen(function*() {
      const connection = yield* Effect.tryPromise({
        try: () => connect(Redacted.isRedacted(url) ? Redacted.value(url) : url),
        catch: (error) => new AMQPConnectionError({ reason: "Failed to establish connection", cause: error })
      })
      return Option.some(connection)
    }))
  yield* Effect.logDebug(`AMQPConnection: connection established`)
}).pipe(
  Effect.withSpan("AMQPConnection.initiateConnection")
)

/** @internal */
export interface CloseConnectionOptions {
  removeAllListeners?: boolean
}

/** @internal */
export const closeConnection = ({ removeAllListeners = true }: CloseConnectionOptions = {}) =>
  Effect.gen(function*() {
    const { connectionRef } = yield* InternalAMQPConnection
    yield* SubscriptionRef.updateEffect(connectionRef, (connection) =>
      Effect.gen(function*() {
        if (Option.isSome(connection)) {
          if (removeAllListeners) {
            connection.value.removeAllListeners()
          }
          yield* annotateSpanWithConnectionProps(connection.value)
          yield* Effect.tryPromise(() => connection.value.close()).pipe(Effect.ignore)
        }
        return Option.none()
      }))
    yield* Effect.logDebug("AMQPConnection: connection closed")
  }).pipe(
    Effect.withSpan("AMQPConnection.closeConnection")
  )

/** @internal */
export const keepConnectionAlive = Effect.gen(function*() {
  const { connectionRef, retryConnectionSchedule } = yield* InternalAMQPConnection
  return yield* Stream.runForEach(closeStream(connectionRef), (event) =>
    Effect.gen(function*() {
      yield* Effect.logDebug(`AMQPConnection: close event received - ${event}`)
      yield* closeConnection()
      yield* Effect.logDebug(`AMQPConnection: reconnecting`)
      yield* initiateConnection.pipe(Effect.retry(retryConnectionSchedule))
    }))
})

/** @internal */
export const monitorConnectionErrors = Effect.gen(function*() {
  const { connectionRef } = yield* InternalAMQPConnection
  return yield* Stream.runForEach(
    errorStream(connectionRef),
    (error) => Effect.logError(`AMQPConnection: error event received - ${error}`)
  )
})

/** @internal */
export const createChannel = Effect.gen(function*() {
  const conn = yield* getOrWaitConnection
  yield* annotateSpanWithConnectionProps(conn)
  return yield* Effect.tryPromise({
    try: () => conn.createChannel(),
    catch: (error) => new AMQPConnectionError({ reason: `Failed to create channel`, cause: error })
  })
}).pipe(
  Effect.withSpan("AMQPConnection.createChannel")
)

/** @internal */
export const createConfirmChannel = Effect.gen(function*() {
  const conn = yield* getOrWaitConnection
  yield* annotateSpanWithConnectionProps(conn)
  return yield* Effect.tryPromise({
    try: () => conn.createConfirmChannel(),
    catch: (error) => new AMQPConnectionError({ reason: `Failed to create ConfirmChannel`, cause: error })
  })
}).pipe(
  Effect.withSpan("AMQPConnection.createConfirmChannel")
)

/** @internal */
export const updateSecret = (...parameters: Parameters<ChannelModel["updateSecret"]>) =>
  Effect.gen(function*() {
    const conn = yield* getOrWaitConnection
    yield* annotateSpanWithConnectionProps(conn)
    return yield* Effect.tryPromise({
      try: () => conn.updateSecret(...parameters),
      catch: (error) => new AMQPConnectionError({ reason: `Failed to create updateSecret`, cause: error })
    })
  }).pipe(
    Effect.withSpan("AMQPConnection.updateSecret")
  )

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
