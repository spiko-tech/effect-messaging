/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Wire from "./internal/jetstreamSchemas.ts"
import type * as T from "./JetStreamTypes.ts"
import type * as NATSConnection from "./NATSConnection.ts"
import * as NATSError from "./NATSError.ts"
import type * as NATSHeaders from "./NATSHeaders.ts"
import type * as NATSMessage from "./NATSMessage.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamMessage")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamMessage {
  readonly [TypeId]: TypeId
  readonly redelivered: boolean
  readonly info: T.DeliveryInfo
  readonly seq: number
  readonly reply: Option.Option<string>
  readonly headers: Option.Option<NATSHeaders.MsgHdrs>
  readonly size: number
  readonly data: Uint8Array
  readonly subject: string
  readonly sid: number
  readonly time: Date
  readonly timestamp: string
  readonly timestampNanos: bigint
  readonly ack: Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly nak: (millis?: number) => Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly working: Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly term: (reason?: string) => Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly ackAck: (options?: { readonly timeout?: number }) => Effect.Effect<boolean, NATSError.JetStreamMessageError>
  readonly next: (
    subject: string,
    options?: Partial<T.PullOptions>
  ) => Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly json: <A = unknown>() => Effect.Effect<A, NATSError.JetStreamMessageError>
  readonly decode: <S extends Schema.Top>(
    schema: S
  ) => Effect.Effect<S["Type"], NATSError.JetStreamMessageError, S["DecodingServices"]>
  readonly string: () => string
}

const AckTokens = Schema.Tuple([
  Schema.Literal("$JS"),
  Schema.Literal("ACK"),
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.NumberFromString.check(Schema.isFinite()),
  Schema.NumberFromString.check(Schema.isFinite()),
  Schema.NumberFromString.check(Schema.isFinite()),
  Schema.String.check(Schema.isPattern(/^\d+$/)),
  Schema.NumberFromString.check(Schema.isFinite())
])

/** @internal */
export const make = Effect.fnUntraced(function*(
  message: NATSMessage.NATSMessage,
  connection: NATSConnection.NATSConnection,
  ackTimeout = 5000
): Effect.fn.Return<JetStreamMessage, NATSError.JetStreamMessageError> {
  const reply = Option.getOrElse(message.reply, () => "")
  const tokens = reply.split(".")
  if (tokens.length === 9) tokens.splice(2, 0, "_", "")
  const parsed = yield* Schema.decodeUnknownEffect(AckTokens)(tokens.slice(0, 11)).pipe(
    Effect.mapError((cause) => new NATSError.JetStreamMessageError({ reason: "Invalid JetStream ack subject", cause }))
  )
  const timestampNanos = BigInt(parsed[9])
  const info = yield* Schema.decodeUnknownEffect(Wire.DeliveryInfo)({
    domain: parsed[2] === "_" ? "" : parsed[2],
    account_hash: parsed[3],
    stream: parsed[4],
    consumer: parsed[5],
    deliveryCount: parsed[6],
    streamSequence: parsed[7],
    deliverySequence: parsed[8],
    timestampNanos: Number(timestampNanos),
    pending: parsed[10],
    redelivered: parsed[6] > 1
  }).pipe(Effect.mapError((cause) => new NATSError.JetStreamMessageError({ reason: "Invalid delivery info", cause })))
  const time = yield* Schema.decodeUnknownEffect(Schema.DateFromMillis)(Number(timestampNanos / BigInt(1_000_000)))
    .pipe(
      Effect.mapError((cause) => new NATSError.JetStreamMessageError({ reason: "Invalid JetStream timestamp", cause }))
    )
  let didAck = false
  const mapError = Effect.mapError((cause: unknown) =>
    new NATSError.JetStreamMessageError({ reason: "JetStream acknowledgement failed", cause })
  )
  const acknowledge = Effect.fnUntraced(function*(payload: string, final = true) {
    if (didAck) return
    // Reserve final acknowledgements before yielding so concurrent ack attempts cannot duplicate them.
    if (final) didAck = true
    yield* connection.publish(reply, payload).pipe(mapError)
  })
  return {
    [TypeId]: TypeId,
    redelivered: info.redelivered,
    info,
    seq: info.streamSequence,
    reply: message.reply,
    headers: message.headers,
    size: message.size,
    data: message.data,
    subject: message.subject,
    sid: message.sid,
    time,
    timestamp: time.toISOString(),
    timestampNanos,
    ack: acknowledge("+ACK"),
    nak: (millis) =>
      acknowledge(millis === undefined ? "-NAK" : `-NAK ${JSON.stringify({ delay: millis * 1_000_000 })}`),
    working: acknowledge("+WPI", false),
    term: (reason = "") => acknowledge(reason ? `+TERM ${reason}` : "+TERM"),
    ackAck: Effect.fnUntraced(function*(options = {}) {
      if (didAck) return false
      didAck = true
      yield* connection.request(reply, "+ACK", { timeout: options.timeout ?? ackTimeout }).pipe(mapError)
      return true
    }),
    next: Effect.fnUntraced(function*(subject, options = {}) {
      if (didAck) return
      didAck = true
      yield* connection.publish(
        reply,
        `+NXT ${
          JSON.stringify({
            batch: 1,
            ...options,
            ...(options.expires === undefined ? {} : { expires: options.expires * 1_000_000 })
          })
        }`,
        { reply: subject }
      ).pipe(mapError)
    }),
    json: <A = unknown>() => message.json<A>().pipe(mapError),
    decode: (schema) => message.decode(schema).pipe(mapError),
    string: () => new TextDecoder().decode(message.data)
  }
})

/** @since 0.1.0 */
export const JetStreamConsumeMessage = Context.Service<JetStreamMessage>(
  "@effect-messaging/nats/JetStreamConsumeMessage"
)
/** @since 0.1.0 */
export const layer = (message: JetStreamMessage): Layer.Layer<JetStreamMessage> =>
  Layer.succeed(JetStreamConsumeMessage, message)
