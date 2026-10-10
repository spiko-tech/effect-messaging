/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Api from "./internal/jetstreamApi.ts"
import type * as Wire from "./internal/jetstreamSchemas.ts"
import * as NATSError from "./NATSError.ts"
import * as NATSHeaders from "./NATSHeaders.ts"
import type * as NATSMessage from "./NATSMessage.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStoredMessage")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamStoredMessage {
  readonly [TypeId]: TypeId
  readonly subject: string
  readonly seq: number
  readonly header: NATSHeaders.MsgHdrs
  readonly data: Uint8Array
  readonly time: Date
  readonly timestamp: string
  readonly lastSequence: number
  readonly pending: number
  readonly json: <A = unknown>(
    reviver?: (key: string, value: unknown) => unknown
  ) => Effect.Effect<A, NATSError.JetStreamStoredMessageError>
  readonly decode: <S extends Schema.Top>(
    schema: S
  ) => Effect.Effect<S["Type"], NATSError.JetStreamStoredMessageError, S["DecodingServices"]>
  readonly string: Effect.Effect<string, NATSError.JetStreamStoredMessageError>
}
/** @internal */
export const make = (value: {
  readonly subject: string
  readonly seq: number
  readonly header: NATSHeaders.MsgHdrs
  readonly data: Uint8Array
  readonly timestamp: string
  readonly lastSequence?: number
  readonly pending?: number
}): JetStreamStoredMessage => {
  const string = Effect.try({
    try: () => new TextDecoder().decode(value.data),
    catch: (cause) => new NATSError.JetStreamStoredMessageError({ reason: "Invalid message text", cause })
  })
  const json = <A = unknown>(reviver?: (key: string, value: unknown) => unknown) =>
    string.pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => JSON.parse(text, reviver) as A,
          catch: (cause) => new NATSError.JetStreamStoredMessageError({ reason: "Invalid message JSON", cause })
        })
      )
    )
  return {
    [TypeId]: TypeId,
    ...value,
    time: new Date(value.timestamp),
    lastSequence: value.lastSequence ?? 0,
    pending: value.pending ?? -1,
    json,
    decode: (schema) =>
      json().pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError((cause) => new NATSError.JetStreamStoredMessageError({ reason: "Invalid message data", cause }))
      ),
    string
  }
}

/** @internal */
export const fromResponse = Effect.fnUntraced(function*(response: typeof Wire.StreamMsgResponse.Type["message"]) {
  yield* Schema.decodeUnknownEffect(Schema.DateFromString)(response.time).pipe(
    Effect.mapError((cause) => new Api.JetStreamApiError({ reason: "Invalid stored message timestamp", cause }))
  )
  return yield* Effect.try({
    try: () =>
      make({
        subject: response.subject,
        seq: response.seq,
        timestamp: response.time,
        data: Uint8Array.from(atob(response.data), (character) => character.charCodeAt(0)),
        header: response.hdrs
          ? NATSHeaders.MsgHdrsImpl.decode(Uint8Array.from(atob(response.hdrs), (character) => character.charCodeAt(0)))
          : NATSHeaders.headers()
      }),
    catch: (cause) => new Api.JetStreamApiError({ reason: "Invalid stored message response", cause })
  })
})

const DirectMetadata = Schema.Struct({
  subject: Schema.String.check(Schema.isMinLength(1)),
  seq: Schema.NumberFromString.check(Schema.isFinite()),
  timestamp: Schema.String.check(Schema.isMinLength(1)),
  lastSequence: Schema.NumberFromString.check(Schema.isFinite()),
  pending: Schema.NumberFromString.check(Schema.isFinite())
})
/** @internal */
export const fromDirect = Effect.fnUntraced(function*(message: NATSMessage.NATSMessage) {
  if (Option.isNone(message.headers)) {
    return yield* new Api.JetStreamApiError({ reason: "Direct message is missing headers" })
  }
  const header = message.headers.value
  const value = yield* Schema.decodeUnknownEffect(DirectMetadata)({
    subject: header.last("Nats-Subject"),
    seq: header.last("Nats-Sequence"),
    timestamp: header.last("Nats-Time-Stamp"),
    lastSequence: header.last("Nats-Last-Sequence") || "0",
    pending: header.last("Nats-Num-Pending") || "-1"
  }).pipe(Effect.mapError((cause) => new Api.JetStreamApiError({ reason: "Invalid direct message headers", cause })))
  yield* Schema.decodeUnknownEffect(Schema.DateFromString)(value.timestamp).pipe(
    Effect.mapError((cause) => new Api.JetStreamApiError({ reason: "Invalid direct message timestamp", cause }))
  )
  return make({ ...value, header, data: message.data })
})
