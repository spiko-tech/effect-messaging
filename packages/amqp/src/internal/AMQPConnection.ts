import { connect, type Connection, type Options } from "amqplib"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { AMQPConnectionError } from "../AMQPError.js"
import { errorStream } from "./errorStream.js"

/** @internal */
export type ConnectionUrl = string | Options.Connect

/** @internal */
export type ConnectionRef = SubscriptionRef.SubscriptionRef<Option.Option<Connection>>
export const ConnectionRef = {
  make: (): Effect.Effect<ConnectionRef> => SubscriptionRef.make(Option.none<Connection>())
}

/** @internal */
const getConnection = (connectionRef: ConnectionRef) =>
  SubscriptionRef.get(connectionRef).pipe(
    Effect.flatten,
    Effect.catchTag("NoSuchElementException", () => new AMQPConnectionError({ reason: "Connection is not available" }))
  )

/** @internal */
export const initiateConnection = (connectionRef: ConnectionRef, url: ConnectionUrl) =>
  SubscriptionRef.updateEffect(connectionRef, () =>
    Effect.gen(function*() {
      const connection = yield* Effect.tryPromise({
        try: () => connect(url),
        catch: (error) => new AMQPConnectionError({ reason: "Failed to establish connection", cause: error })
      })
      return Option.some(connection)
    })).pipe(
      Effect.tap(() => Effect.logDebug(`AMQPConnection: connection established`)),
      Effect.tapError((error) => Effect.logError(`AMQPConnection: failed to establish connection: ${error}`)),
      Effect.withSpan("AMQPConnection.initiateConnection")
    )

/** @internal */
export const closeConnection = (connectionRef: ConnectionRef) =>
  SubscriptionRef.updateEffect(connectionRef, (connection) =>
    Effect.gen(function*() {
      if (Option.isSome(connection)) {
        connection.value.removeAllListeners()
        yield* Effect.tryPromise(() => connection.value.close()).pipe(Effect.ignore)
      }
      return Option.none()
    })).pipe(
      Effect.tap(() => Effect.logDebug("AMQPConnection: connection closed")),
      Effect.withSpan("AMQPConnection.closeConnection")
    )

/** @internal */
const reconnect = (connectionRef: ConnectionRef, url: ConnectionUrl) =>
  Effect.gen(function*() {
    yield* closeConnection(connectionRef)
    yield* initiateConnection(connectionRef, url).pipe(
      Effect.retry(Schedule.forever.pipe(Schedule.addDelay(() => 1000)))
    )
  })

/** @internal */
export const watchConnection = (connectionRef: ConnectionRef, url: ConnectionUrl) =>
  Stream.runForEach(errorStream(connectionRef), (error) =>
    Effect.gen(function*() {
      yield* Effect.logError(`AMQPConnection: connection error: ${error}`)
      yield* reconnect(connectionRef, url)
    }))

/** @internal */
export const createChannel = (connectionRef: ConnectionRef) =>
  Effect.gen(function*() {
    const conn = yield* getConnection(connectionRef)
    return yield* Effect.tryPromise({
      try: () => conn.createChannel(),
      catch: (error) => new AMQPConnectionError({ reason: `Failed to create channel`, cause: error })
    })
  })
