/**
 * A scoped logical connection over replaceable AMQP 0-9-1 sessions.
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import type * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import type * as Socket from "effect/socket/Socket"
import type * as Stream from "effect/Stream"
import type * as AMQPChannel from "./AMQPChannel.ts"
import type * as AMQPError from "./AMQPError.ts"
import type * as AMQPTypes from "./AMQPTypes.ts"
import * as internal from "./internal/client.ts"
import { ConnectionTypeId } from "./internal/typeIds.ts"

/**
 * @since 0.1.0
 */
export const TypeId: typeof ConnectionTypeId = ConnectionTypeId

/** @since 0.8.0 */
export interface ConnectionState {
  readonly state:
    | "Connecting"
    | "Handshaking"
    | "Recovering"
    | "Ready"
    | "Reconnecting"
    | "Closing"
    | "Closed"
    | "Failed"
  readonly generation: number
  readonly blocked?: string
  /** Most recent session or broker channel failure; a channel error need not make the connection Failed. */
  readonly error?: AMQPError.AMQPError
}

/** @since 0.8.0 */
export interface AMQPConnectionOptions {
  readonly username?: string
  readonly password?: string | Redacted.Redacted<string>
  readonly virtualHost?: string
  readonly heartbeat?: number
  readonly frameMax?: number
  readonly channelMax?: number
  readonly connectionTimeout?: Duration.Input
  readonly waitConnectionTimeout?: Duration.Input
  readonly shutdownTimeout?: Duration.Input
  readonly retryConnectionSchedule?: Schedule.Schedule<unknown, AMQPError.AMQPConnectionError>
  readonly maxMessageBytes?: number
  readonly maxBufferedBytes?: number
  readonly maxOutboundBytes?: number
  readonly maxPendingOperations?: number
  readonly clientProperties?: AMQPTypes.FieldTable
  readonly connectionName?: string
}

/**
 * Transport construction must create a fresh Socket each time it is evaluated.
 * Never pass an Effect.succeed of a shared reconnecting Socket.
 * @since 0.8.0
 */
export type SocketFactory<R = never> = Effect.Effect<Socket.Socket, Socket.SocketError, R>

/** @since 0.1.0 */
export interface AMQPConnection {
  readonly [TypeId]: typeof TypeId
  readonly createChannel: (
    options?: AMQPChannel.AMQPChannelOptions
  ) => Effect.Effect<AMQPChannel.AMQPChannel, AMQPError.AMQPError, Scope.Scope>
  readonly serverProperties: Effect.Effect<AMQPTypes.FieldTable, AMQPError.AMQPError>
  readonly state: Effect.Effect<ConnectionState>
  readonly changes: Stream.Stream<ConnectionState>
  readonly awaitReady: Effect.Effect<void, AMQPError.AMQPError>
  /** Retire the current session and wait for recovery. This never replays publishes. */
  readonly reconnect: Effect.Effect<void, AMQPError.AMQPError>
  readonly updateSecret: (
    secret: string | Redacted.Redacted<string>,
    reason: string
  ) => Effect.Effect<void, AMQPError.AMQPError>
  readonly close: Effect.Effect<void>
}

/** @since 0.1.0 */
export const AMQPConnection = Context.Service<AMQPConnection>("@effect-messaging/amqp/AMQPConnection")

/** @since 0.8.0 */
export const make = <R>(
  socketFactory: SocketFactory<R>,
  options: AMQPConnectionOptions = {}
): Effect.Effect<AMQPConnection, AMQPError.AMQPError, Scope.Scope | R> => internal.make(socketFactory, options)

/** @since 0.8.0 */
export const layer = <R>(
  socketFactory: SocketFactory<R>,
  options: AMQPConnectionOptions = {}
): Layer.Layer<AMQPConnection, AMQPError.AMQPError, R> => Layer.effect(AMQPConnection, make(socketFactory, options))
