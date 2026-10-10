/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as NATSError from "./NATSError.ts"
import { NATSMessageError } from "./NATSError.ts"
import type * as NATSHeaders from "./NATSHeaders.ts"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSMessage")
/** @since 0.1.0 */
export type TypeId = typeof TypeId

/**
 * Service request metadata carried by the Nats-Request-Info header.
 * @since 1.0.0
 */
export const RequestInfo = Schema.StructWithRest(
  Schema.Struct({
    acc: Schema.String,
    rtt: Schema.Number,
    start: Schema.optionalKey(Schema.Union([Schema.DateFromString, Schema.Literal("")])),
    stop: Schema.optionalKey(Schema.Union([Schema.DateFromString, Schema.Literal("")])),
    host: Schema.optionalKey(Schema.String),
    id: Schema.optionalKey(Schema.String),
    svc: Schema.optionalKey(Schema.String),
    user: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    lang: Schema.optionalKey(Schema.String),
    ver: Schema.optionalKey(Schema.String),
    server: Schema.optionalKey(Schema.String),
    cluster: Schema.optionalKey(Schema.String),
    alts: Schema.optionalKey(Schema.Array(Schema.String)),
    jwt: Schema.optionalKey(Schema.String),
    issuer_key: Schema.optionalKey(Schema.String),
    name_tag: Schema.optionalKey(Schema.String),
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
    client_type: Schema.optionalKey(Schema.String),
    client_id: Schema.optionalKey(Schema.String),
    nonce: Schema.optionalKey(Schema.String)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
/** @since 1.0.0 */
export interface RequestInfo extends Schema.Schema.Type<typeof RequestInfo> {}

/** @since 0.1.0 */
export interface NATSMessage {
  readonly [TypeId]: TypeId
  readonly subject: string
  readonly sid: number
  readonly reply: Option.Option<string>
  readonly data: Uint8Array
  readonly size: number
  readonly requestInfo: Effect.Effect<Option.Option<RequestInfo>, NATSMessageError>
  readonly headers: Option.Option<NATSHeaders.MsgHdrs>
  readonly respond: (
    payload?: NATSOptions.Payload,
    options?: NATSOptions.PublishOptions
  ) => Effect.Effect<boolean, NATSError.NATSMessageError>
  readonly json: <T = unknown>(reviver?: (key: string, value: unknown) => unknown) => Effect.Effect<T, NATSMessageError>
  readonly decode: <S extends Schema.Top>(
    schema: S
  ) => Effect.Effect<S["Type"], NATSMessageError, S["DecodingServices"]>
  readonly string: Effect.Effect<string, NATSMessageError>
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** @internal */
export const make = (
  frame: {
    subject: string
    sid: number
    reply?: string
    data: Uint8Array
    headers?: NATSHeaders.MsgHdrs
    wireBytes?: number
  },
  publish: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: NATSOptions.PublishOptions
  ) => Effect.Effect<void, NATSError.NATSConnectionError>
): NATSMessage => {
  const string = Effect.try({
    try: () => decoder.decode(frame.data),
    catch: (cause) => new NATSMessageError({ reason: "Failed to decode message text", cause })
  })
  const json = <T = unknown>(reviver?: (key: string, value: unknown) => unknown): Effect.Effect<T, NATSMessageError> =>
    Effect.flatMap(string, (text) =>
      Effect.try({
        try: () => JSON.parse(text, reviver) as T,
        catch: (cause) => new NATSMessageError({ reason: "Failed to parse message JSON", cause })
      }))
  return {
    [TypeId]: TypeId,
    subject: frame.subject,
    sid: frame.sid,
    reply: Option.fromNullishOr(frame.reply),
    data: frame.data,
    size: encoder.encode(frame.subject).length + encoder.encode(frame.reply ?? "").length +
      (frame.wireBytes ??
        frame.data.length +
          (frame.headers === undefined ? 0 : encoder.encode(frame.headers.toString()).length)),
    requestInfo: Effect.suspend(() => {
      const value = frame.headers?.get("Nats-Request-Info")
      return value === undefined || value === "" ?
        Effect.succeed(Option.none()) :
        Schema.decodeUnknownEffect(Schema.fromJsonString(RequestInfo))(value).pipe(
          Effect.map(Option.some),
          Effect.mapError((cause) => new NATSMessageError({ reason: "Invalid service request metadata", cause }))
        )
    }),
    headers: Option.fromNullishOr(frame.headers),
    respond: (payload, options) =>
      frame.reply
        ? publish(frame.reply, payload, options).pipe(
          Effect.as(true),
          Effect.mapError((cause) => new NATSMessageError({ reason: "Failed to respond to message", cause }))
        )
        : Effect.succeed(false),
    json,
    decode: (schema) =>
      json().pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError((cause) => new NATSMessageError({ reason: "Message does not satisfy its schema", cause }))
      ),
    string
  }
}

/** @since 0.3.0 */
export const NATSConsumeMessage = Context.Service<NATSMessage>("@effect-messaging/nats/NATSConsumeMessage")
/** @since 0.3.0 */
export const layer = (message: NATSMessage): Layer.Layer<NATSMessage> => Layer.succeed(NATSConsumeMessage, message)
