/**
 * A scoped NATS connection over replaceable Effect sockets.
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as Socket from "effect/socket/Socket"
import type * as Stream from "effect/Stream"
import * as internal from "./internal/client.ts"
import * as Services from "./internal/clientServices.ts"
import type * as NATSError from "./NATSError.ts"
import type * as NATSMessage from "./NATSMessage.ts"
import type * as NATSOptions from "./NATSOptions.ts"
import type * as NATSSubscription from "./NATSSubscription.ts"

/** @since 0.1.0 */
export const TypeId: typeof Services.ConnectionTypeId = Services.ConnectionTypeId
/** @since 0.1.0 */
export type TypeId = typeof TypeId

/**
 * Evaluated for every physical connection. Return a fresh Socket; the client
 * owns reader acquisition, TLS negotiation and reconnection.
 * @since 1.0.0
 */
export type SocketFactory<R = never> = (
  server: string,
  metadata: NATSOptions.Server
) => Effect.Effect<Socket.Socket, Socket.SocketError, R>

/** @since 1.0.0 */
export interface Server extends NATSOptions.Server {}

/** @since 1.0.0 */
export interface ConnectionState {
  readonly state: "Connecting" | "Connected" | "Reconnecting" | "Draining" | "Closed"
  readonly generation: number
  readonly server: string
  readonly error?: NATSError.NATSConnectionError
}

/** @since 0.1.0 */
export interface NATSConnection {
  readonly [TypeId]: TypeId
  readonly info: Option.Option<NATSOptions.ServerInfo>
  readonly publish: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: NATSOptions.PublishOptions
  ) => Effect.Effect<void, NATSError.NATSConnectionError>
  readonly publishMessage: (message: NATSMessage.NATSMessage) => Effect.Effect<void, NATSError.NATSConnectionError>
  readonly respondMessage: (message: NATSMessage.NATSMessage) => Effect.Effect<boolean, NATSError.NATSConnectionError>
  readonly request: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<NATSOptions.RequestOptions>
  ) => Effect.Effect<NATSMessage.NATSMessage, NATSError.NATSConnectionError>
  readonly requestMany: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<NATSOptions.RequestManyOptions>
  ) => Effect.Effect<
    Stream.Stream<NATSMessage.NATSMessage, NATSError.NATSConnectionError>,
    NATSError.NATSConnectionError
  >
  /** Creates a unique reply subject using this connection's configured inbox prefix. @since 1.0.0 */
  readonly createInbox: Effect.Effect<string>
  readonly subscribe: (
    subject: string,
    options?: NATSOptions.SubscriptionOptions
  ) => Effect.Effect<NATSSubscription.NATSSubscription, NATSError.NATSConnectionError>
  readonly flush: Effect.Effect<void, NATSError.NATSConnectionError>
  readonly drain: Effect.Effect<void, NATSError.NATSConnectionError>
  readonly close: Effect.Effect<void>
  readonly closed: Effect.Effect<Option.Option<NATSError.NATSConnectionError>>
  readonly isClosed: Effect.Effect<boolean>
  readonly isDraining: Effect.Effect<boolean>
  readonly getServer: Effect.Effect<string, NATSError.NATSConnectionError>
  readonly getServers: Effect.Effect<ReadonlyArray<Server>>
  readonly setServers: (servers: ReadonlyArray<string>) => Effect.Effect<void, NATSError.NATSConnectionError>
  readonly reconnect: Effect.Effect<void, NATSError.NATSConnectionError>
  readonly status: Effect.Effect<Stream.Stream<NATSOptions.Status, NATSError.NATSConnectionError>>
  readonly state: Effect.Effect<ConnectionState>
  readonly changes: Stream.Stream<ConnectionState>
  readonly stats: Effect.Effect<NATSOptions.Stats>
  readonly rtt: Effect.Effect<number, NATSError.NATSConnectionError>
}

/** @since 0.1.0 */
export const NATSConnection = Services.Connection

/** @since 1.0.0 */
export const make = <R>(
  socketFactory: SocketFactory<R>,
  options: NATSOptions.ConnectionOptions = {}
): Effect.Effect<NATSConnection, NATSError.NATSConnectionError, Scope.Scope | R> =>
  internal.make(socketFactory, options)

/** @since 1.0.0 */
export const layer = <R>(
  socketFactory: SocketFactory<R>,
  options: NATSOptions.ConnectionOptions = {}
): Layer.Layer<NATSConnection, NATSError.NATSConnectionError, R> =>
  Layer.effect(NATSConnection, make(socketFactory, options))

/** @since 0.1.0 */
export const layerWebSocket = (options: NATSOptions.WsConnectionOptions = {}): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> =>
  Layer.unwrap(
    Effect.promise(() => import("./NATSWebSocketConnection.ts")).pipe(
      Effect.map((websocket) => websocket.layer(options))
    )
  )

/**
 * Prefer the explicit NATSNodeConnection module for Node transport wiring.
 * Loading the Node adapter lazily keeps browser imports independent of Node.
 * @since 0.1.0
 */
export const layerNode = (options: NATSOptions.NodeConnectionOptions = {}): Layer.Layer<
  NATSConnection,
  NATSError.NATSConnectionError
> =>
  Layer.unwrap(Effect.promise(() => import("./NATSNodeConnection.ts")).pipe(Effect.map((node) => node.layer(options))))
