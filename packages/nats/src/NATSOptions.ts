/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Socket from "effect/socket/Socket"
import type * as NATSAuth from "./NATSAuth.ts"
import * as NATSError from "./NATSError.ts"
import type * as NATSHeaders from "./NATSHeaders.ts"
import type * as NATSMessage from "./NATSMessage.ts"
import type * as NATSSubscription from "./NATSSubscription.ts"

/** @since 0.1.0 */
export type Payload = string | Uint8Array
const infoNonNegativeInteger = Schema.Int.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const infoPositiveInteger = Schema.Int.check(Schema.isFinite(), Schema.isGreaterThan(0))
const infoPort = infoPositiveInteger.check(Schema.isLessThanOrEqualTo(65535))
/** @since 0.1.0 */
export const ServerInfo = Schema.StructWithRest(
  Schema.Struct({
    server_id: Schema.String,
    server_name: Schema.String,
    version: Schema.String,
    go: Schema.String,
    host: Schema.String,
    port: infoPort,
    proto: infoNonNegativeInteger,
    max_payload: infoPositiveInteger,
    client_id: infoNonNegativeInteger,
    client_ip: Schema.optionalKey(Schema.String),
    auth_required: Schema.optionalKey(Schema.Boolean),
    cluster: Schema.optionalKey(Schema.String),
    connect_urls: Schema.optionalKey(Schema.Array(Schema.String)),
    ws_connect_urls: Schema.optionalKey(Schema.Array(Schema.String)),
    git_commit: Schema.optionalKey(Schema.String),
    headers: Schema.optionalKey(Schema.Boolean),
    jetstream: Schema.optionalKey(Schema.Boolean),
    ldm: Schema.optionalKey(Schema.Boolean),
    nonce: Schema.optionalKey(Schema.String),
    tls_available: Schema.optionalKey(Schema.Boolean),
    tls_required: Schema.optionalKey(Schema.Boolean),
    tls_verify: Schema.optionalKey(Schema.Boolean),
    api_lvl: Schema.optionalKey(infoNonNegativeInteger)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
/** @since 0.1.0 */
export const ServerInfoUpdate = Schema.StructWithRest(
  Schema.Struct({
    server_id: Schema.optionalKey(Schema.String),
    server_name: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
    go: Schema.optionalKey(Schema.String),
    host: Schema.optionalKey(Schema.String),
    port: Schema.optionalKey(infoPort),
    proto: Schema.optionalKey(infoNonNegativeInteger),
    max_payload: Schema.optionalKey(infoPositiveInteger),
    client_id: Schema.optionalKey(infoNonNegativeInteger),
    client_ip: Schema.optionalKey(Schema.String),
    auth_required: Schema.optionalKey(Schema.Boolean),
    cluster: Schema.optionalKey(Schema.String),
    connect_urls: Schema.optionalKey(Schema.Array(Schema.String)),
    ws_connect_urls: Schema.optionalKey(Schema.Array(Schema.String)),
    git_commit: Schema.optionalKey(Schema.String),
    headers: Schema.optionalKey(Schema.Boolean),
    jetstream: Schema.optionalKey(Schema.Boolean),
    ldm: Schema.optionalKey(Schema.Boolean),
    nonce: Schema.optionalKey(Schema.String),
    tls_available: Schema.optionalKey(Schema.Boolean),
    tls_required: Schema.optionalKey(Schema.Boolean),
    tls_verify: Schema.optionalKey(Schema.Boolean),
    api_lvl: Schema.optionalKey(infoNonNegativeInteger)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
/** @since 0.1.0 */
export interface ServerInfoUpdate extends Schema.Schema.Type<typeof ServerInfoUpdate> {}

/** @since 0.1.0 */
export interface ServerInfo extends Schema.Schema.Type<typeof ServerInfo> {}
/** @since 0.1.0 */
export interface TraceOptions {
  /** Either boolean enables trace-only, matching the official v3.4 client. */
  traceOnly?: boolean
  traceDestination?: string
}
/** @since 0.1.0 */
export interface PublishOptions extends TraceOptions {
  reply?: string
  headers?: NATSHeaders.MsgHdrs
}
/** @since 0.1.0 */
export interface RequestOptions extends TraceOptions {
  timeout: number
  headers?: NATSHeaders.MsgHdrs
  noMux?: boolean
  reply?: string
}
/** @since 0.1.0 */
export type RequestStrategy = "timer" | "count" | "stall" | "sentinel"
/** @since 0.1.0 */
export interface RequestManyOptions extends TraceOptions {
  strategy: RequestStrategy
  maxWait: number
  headers?: NATSHeaders.MsgHdrs
  maxMessages?: number
  noMux?: boolean
  stall?: number
}
/** @since 0.1.0 */
export interface SubscriptionOptions {
  queue?: string
  max?: number
  timeout?: number
  callback?: (
    error: Option.Option<NATSError.NATSSubscriptionError>,
    message: Option.Option<NATSMessage.NATSMessage>
  ) => void | Promise<void> | Effect.Effect<void, NATSError.NATSSubscriptionError>
  slow?: number
  capacity?: number
  maxPendingMessages?: number
  maxPendingBytes?: number
}
/** @since 0.1.0 */
export interface Stats {
  inBytes: number
  outBytes: number
  inMsgs: number
  outMsgs: number
}
/** @since 0.1.0 */
export type Status =
  | { type: "disconnect" | "reconnect" | "ldm"; server: string }
  | { type: "reconnecting" | "staleConnection" | "forceReconnect" | "close" }
  | { type: "update"; added?: Array<string>; deleted?: Array<string> }
  | { type: "error"; error: Error }
  | { type: "ping"; pendingPings: number }
  | { type: "slowConsumer"; sub: NATSSubscription.NATSSubscription; pending: number }
/** @since 0.1.0 */
export interface TlsOptions {
  handshakeFirst?: boolean
  certFile?: string
  cert?: string | Uint8Array
  caFile?: string
  ca?: string | Uint8Array
  keyFile?: string
  key?: string | Uint8Array
}
/** @since 0.1.0 */
export interface Server {
  readonly hostname: string
  readonly port: number
  readonly listen: string
  readonly src: string
  readonly tlsName: string
  readonly reconnects: number
  readonly lastConnect: number
  readonly gossiped: boolean
  readonly didConnect: boolean
}
/** @since 0.1.0 */
export type ReconnectToServerHandler = (
  pool: ReadonlyArray<Server>,
  info: Option.Option<ServerInfo>
) => Option.Option<Server | { server: Server; delay: number }>
/** @since 0.1.0 */
export interface ConnectionOptions {
  authenticator?: NATSAuth.Authenticator | Array<NATSAuth.Authenticator>
  debug?: boolean
  maxPingOut?: number
  maxReconnectAttempts?: number
  name?: string
  noEcho?: boolean
  noRandomize?: boolean
  pass?: string
  pedantic?: boolean
  pingInterval?: number
  port?: number
  reconnect?: boolean
  reconnectDelayHandler?: () => number
  reconnectJitter?: number
  reconnectJitterTLS?: number
  reconnectTimeWait?: number
  servers?: Array<string> | string
  timeout?: number
  tls?: TlsOptions | false
  token?: string
  user?: string
  verbose?: boolean
  waitOnFirstConnect?: boolean
  ignoreClusterUpdates?: boolean
  inboxPrefix?: string
  ignoreAuthErrorAbort?: boolean
  noAsyncTraces?: boolean
  resolve?: boolean
  reconnectToServer?: ReconnectToServerHandler
  pendingLimit?: number
  maxBufferedBytes?: number
  maxPendingCommands?: number
  maxControlLine?: number
  drainTimeout?: number
}
/** @since 0.1.0 */
export interface NodeTlsOptions extends TlsOptions {
  rejectUnauthorized?: boolean
  servername?: string
}
/** @since 0.1.0 */
export interface NodeConnectionOptions extends Omit<ConnectionOptions, "tls"> {
  tls?: NodeTlsOptions | false
}

/** @since 0.1.0 */
export type Auth = NATSAuth.Auth
/** @since 0.1.0 */
export type Authenticator = NATSAuth.Authenticator

const positiveNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const nonNegativeNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const connectionBudgets = Schema.Struct({
  timeout: Schema.optionalKey(positiveNumber),
  pingInterval: Schema.optionalKey(positiveNumber),
  maxPingOut: Schema.optionalKey(positiveInteger),
  maxReconnectAttempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
  reconnectTimeWait: Schema.optionalKey(nonNegativeNumber),
  reconnectJitter: Schema.optionalKey(nonNegativeNumber),
  reconnectJitterTLS: Schema.optionalKey(nonNegativeNumber),
  pendingLimit: Schema.optionalKey(positiveInteger),
  maxBufferedBytes: Schema.optionalKey(positiveInteger),
  maxPendingCommands: Schema.optionalKey(positiveInteger),
  maxControlLine: Schema.optionalKey(positiveInteger),
  drainTimeout: Schema.optionalKey(positiveNumber),
  port: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65535)))
})
const subscriptionBudgets = Schema.Struct({
  max: Schema.optionalKey(positiveInteger),
  timeout: Schema.optionalKey(positiveNumber),
  slow: Schema.optionalKey(Schema.Natural),
  capacity: Schema.optionalKey(positiveInteger),
  maxPendingMessages: Schema.optionalKey(positiveInteger),
  maxPendingBytes: Schema.optionalKey(positiveInteger)
})
const requestManyBudgets = Schema.Struct({
  maxWait: Schema.optionalKey(positiveNumber),
  stall: Schema.optionalKey(positiveNumber),
  maxMessages: Schema.optionalKey(Schema.Int),
  strategy: Schema.optionalKey(Schema.Literals(["timer", "count", "stall", "sentinel"]))
})
/** @internal */
export const validateConnectionOptions = Effect.fnUntraced(function*(options: ConnectionOptions) {
  yield* Schema.decodeUnknownEffect(connectionBudgets)(options).pipe(
    Effect.mapError((cause) =>
      new NATSError.NATSConnectionError({ reason: "Invalid connection options", code: "invalid_argument", cause })
    )
  )
})
/** @internal */
export const validateSubscriptionOptions = Effect.fnUntraced(function*(options: SubscriptionOptions) {
  yield* Schema.decodeUnknownEffect(subscriptionBudgets)(options).pipe(
    Effect.mapError((cause) =>
      new NATSError.NATSConnectionError({ reason: "Invalid subscription options", code: "invalid_argument", cause })
    )
  )
})
/** @internal */
export const validateRequestManyOptions = Effect.fnUntraced(function*(options: Partial<RequestManyOptions>) {
  yield* Schema.decodeUnknownEffect(requestManyBudgets)(options).pipe(
    Effect.mapError((cause) =>
      new NATSError.NATSConnectionError({ reason: "Invalid requestMany options", code: "invalid_argument", cause })
    )
  )
})

/** @since 1.0.0 */
export interface WebSocketFactoryResult {
  readonly socket: Socket.WebSocketLike
  readonly encrypted: boolean
}
/** @since 1.0.0 */
export type WsSocketFactory = (
  url: string,
  options: ConnectionOptions
) =>
  | WebSocketFactoryResult
  | Promise<WebSocketFactoryResult>
  | Effect.Effect<WebSocketFactoryResult, Socket.SocketError>
/** @since 1.0.0 */
export interface WsConnectionOptions extends ConnectionOptions {
  readonly wsFactory?: WsSocketFactory
  readonly webSocketConstructor?: Socket.WebSocketConstructor["Service"]
  readonly protocols?: string | Array<string>
  readonly highWaterMark?: number
}
