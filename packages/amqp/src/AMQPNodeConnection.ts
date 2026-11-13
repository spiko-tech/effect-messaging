/**
 * Node-compatible TCP/TLS transport wiring. Import this module explicitly;
 * the package root does not import platform modules.
 * @since 0.8.0
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type * as Scope from "effect/Scope"
import type * as Tls from "node:tls"
import * as AMQPConnection from "./AMQPConnection.ts"
import * as AMQPError from "./AMQPError.ts"
import * as Configuration from "./internal/configuration.ts"

/** @since 0.8.0 */
export interface ConnectionOptions extends AMQPConnection.AMQPConnectionOptions {
  readonly hostname?: string
  readonly port?: number
  readonly tls?: boolean | Tls.ConnectionOptions
}

/** @since 0.8.0 */
export type ConnectionUrl = string | Redacted.Redacted<string> | ConnectionOptions

const Endpoint = Schema.Struct({
  hostname: Schema.NonEmptyString,
  port: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })))
})

const UrlNumber = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
)

const ConnectionUri = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === "amqp:" || url.protocol === "amqps:")
)
const UriComponent = Schema.String.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transformEffect({
    decode: (value: string) =>
      Effect.try({
        try: () => decodeURIComponent(value),
        catch: () => new SchemaIssue.InvalidValue({ message: "Invalid encoded URL component" })
      }),
    encode: (value: string) =>
      Effect.try({
        try: () => encodeURIComponent(value),
        catch: () => new SchemaIssue.InvalidValue({ message: "Invalid URL component" })
      })
  })
))
const decodeUri = Schema.decodeUnknownEffect(ConnectionUri)
const decodeComponent = Schema.decodeUnknownEffect(UriComponent)
const decodeNumber = Schema.decodeUnknownEffect(UrlNumber)
const nodeSchema = Schema.Struct({
  ...Configuration.connectionFields,
  hostname: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  tls: Schema.optionalKey(Schema.Union([
    Schema.Boolean,
    Schema.declare<Tls.ConnectionOptions>((value): value is Tls.ConnectionOptions => Predicate.isObject(value))
  ]))
})
const decodeNodeOptions = Schema.decodeUnknownEffect(Configuration.snapshot(nodeSchema, Object.keys(nodeSchema.fields)))
const normalize = Effect.fnUntraced(function*(
  input: ConnectionUrl,
  overrides: AMQPConnection.AMQPConnectionOptions
): Effect.fn.Return<ConnectionOptions, Schema.SchemaError> {
  const captured = yield* Configuration.connection(overrides)
  const text = yield* Effect.try({
    try: () => typeof input === "string" ? input : Redacted.isRedacted(input) ? Redacted.value(input) : undefined,
    catch: () => new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "Invalid connection input" }))
  })
  if (text === undefined) {
    return { ...yield* decodeNodeOptions(input), ...captured }
  }
  const url = yield* decodeUri(text)
  const numeric = (name: string) => {
    const value = url.searchParams.get(name)
    return value === null ? Effect.succeed(undefined) : decodeNumber(value)
  }
  const heartbeat = yield* numeric("heartbeat")
  const frameMax = yield* numeric("frameMax")
  const channelMax = yield* numeric("channelMax")
  // URL normalizes empty userinfo away. Preserve explicitly empty credentials
  // instead of silently replacing them with the default guest account.
  const authority = text.trim().replace(/[\t\n\r]/g, "").match(/^amqps?:\/\/([^/?#]*)/i)?.[1] ?? ""
  const at = authority.lastIndexOf("@")
  const userinfo = at >= 0 ? authority.slice(0, at) : undefined
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : url.protocol === "amqps:" ? 5671 : 5672,
    username: userinfo === undefined ? "guest" : yield* decodeComponent(url.username),
    password: Redacted.make(userinfo?.includes(":") ? yield* decodeComponent(url.password) : "guest"),
    virtualHost: url.pathname.length > 1 ? yield* decodeComponent(url.pathname.slice(1)) : "/",
    tls: url.protocol === "amqps:",
    ...(heartbeat === undefined ? {} : { heartbeat }),
    ...(frameMax === undefined ? {} : { frameMax }),
    ...(channelMax === undefined ? {} : { channelMax }),
    ...captured
  }
})

/** @since 0.8.0 */
export const make = Effect.fn("AMQPNodeConnection.make")(function*(
  input: ConnectionUrl,
  options: AMQPConnection.AMQPConnectionOptions = {}
): Effect.fn.Return<AMQPConnection.AMQPConnection, AMQPError.AMQPError, Scope.Scope> {
  const config = yield* normalize(input, options).pipe(Effect.mapError(
    // URL/parser errors may retain the original URL, including its credentials.
    () => new AMQPError.AMQPConnectionError({ reason: "Invalid connection URL", permanent: true })
  ))
  const endpoint = yield* Schema.decodeUnknownEffect(Endpoint)({
    hostname: config.hostname ?? "localhost",
    port: config.port ?? (config.tls ? 5671 : 5672)
  }).pipe(
    Effect.mapError((cause) =>
      new AMQPError.AMQPConnectionError({ reason: "Invalid connection endpoint", cause, permanent: true })
    )
  )
  const transportOptions = {
    host: endpoint.hostname,
    port: endpoint.port,
    // Method, header and body frames must not wait for a delayed TCP ACK between small writes.
    noDelay: true,
    openTimeout: config.connectionTimeout ?? "10 seconds"
  }
  const tlsOptions = typeof config.tls === "object"
    ? yield* Configuration.record(config.tls).pipe(
      Effect.mapError(() => new AMQPError.AMQPConnectionError({ reason: "Invalid TLS options", permanent: true }))
    )
    : {}
  const socket = config.tls
    ? NodeSocket.makeTls({
      ...transportOptions,
      servername: endpoint.hostname,
      ...tlsOptions
    })
    : NodeSocket.makeNet(transportOptions)
  return yield* AMQPConnection.make(socket, config)
})

/** @since 0.8.0 */
export const layer = (
  input: ConnectionUrl,
  options: AMQPConnection.AMQPConnectionOptions = {}
): Layer.Layer<AMQPConnection.AMQPConnection, AMQPError.AMQPError> =>
  Layer.effect(AMQPConnection.AMQPConnection, make(input, options))
