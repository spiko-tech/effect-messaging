import * as Cause from "effect/Cause"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import type * as AMQPAuthentication from "../AMQPAuthentication.ts"
import type * as AMQPError from "../AMQPError.ts"
import type * as AMQPTypes from "../AMQPTypes.ts"
import * as Protocol from "./protocol.ts"

/** Guard named foreign reads without traversing or copying opaque runtime values. @internal */
export const snapshot = <A, E>(schema: Schema.Codec<A, E>, names: ReadonlyArray<string>) =>
  Schema.declareConstructor<A, unknown>()([schema], ([codec]) => {
    const decode = SchemaParser.decodeUnknownEffect(codec)
    return Effect.fnUntraced(function*(input, _ast, options) {
      if (!Predicate.isObject(input)) {
        return yield* Effect.fail(new SchemaIssue.InvalidValue({ message: "Invalid options" }))
      }
      const values = yield* Effect.try({
        try: () => {
          const values: Record<string, unknown> = Object.create(null)
          for (const name of names) {
            const value = Reflect.get(input, name)
            if (value !== undefined) values[name] = value
          }
          return values
        },
        catch: () => new SchemaIssue.InvalidValue({ message: "Invalid options" })
      })
      return yield* decode(values, options).pipe(Effect.catchCause((cause) =>
        Cause.hasDies(cause)
          ? Effect.fail(new SchemaIssue.InvalidValue({ message: "Invalid options" }))
          : Effect.failCause(cause)
      ))
    })
  })

const durationInput = Schema.Union([
  Schema.Duration,
  Schema.Number,
  Schema.BigInt,
  Schema.toEncoded(Schema.DurationFromString),
  Schema.Tuple([Schema.Number, Schema.Number])
])
const duration = Schema.declare<Duration.Input>((input): input is Duration.Input => Schema.is(durationInput)(input))
const password = Schema.declare<string | Redacted.Redacted<string>>((
  input
): input is string | Redacted.Redacted<string> =>
  typeof input === "string" || (Redacted.isRedacted(input) && typeof Redacted.value(input) === "string")
)
const authentication = Schema.declare<AMQPAuthentication.Authentication>(
  (input): input is AMQPAuthentication.Authentication =>
    input === "PLAIN" || input === "AMQPLAIN" || input === "EXTERNAL" || Predicate.isObject(input)
)
const retrySchedule = Schema.declare<Schedule.Schedule<unknown, AMQPError.AMQPConnectionError>>(
  (input): input is Schedule.Schedule<unknown, AMQPError.AMQPConnectionError> => Schedule.isSchedule(input)
)
const fieldTable = Schema.declare<AMQPTypes.FieldTable>(
  (input): input is AMQPTypes.FieldTable => Predicate.isObject(input)
)
export const connectionFields = {
  username: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(password),
  authentication: Schema.optionalKey(authentication),
  virtualHost: Schema.optionalKey(Schema.String),
  heartbeat: Schema.optionalKey(Protocol.unsigned(65535)),
  frameMax: Schema.optionalKey(Protocol.unsigned(0xffffffff)),
  channelMax: Schema.optionalKey(Protocol.unsigned(65535)),
  connectionTimeout: Schema.optionalKey(duration),
  waitConnectionTimeout: Schema.optionalKey(duration),
  shutdownTimeout: Schema.optionalKey(duration),
  retryConnectionSchedule: Schema.optionalKey(retrySchedule),
  maxMessageBytes: Schema.optionalKey(Protocol.unsigned(0x7fffffff)),
  maxBufferedBytes: Schema.optionalKey(Protocol.unsigned(0x7fffffff)),
  maxOutboundBytes: Schema.optionalKey(Protocol.unsigned(0x7fffffff)),
  maxPendingOperations: Schema.optionalKey(Protocol.unsigned(65535)),
  clientProperties: Schema.optionalKey(fieldTable),
  connectionName: Schema.optionalKey(Schema.String)
}
const connectionSchema = Schema.Struct(connectionFields)
export const connection = Schema.decodeUnknownEffect(snapshot(connectionSchema, Object.keys(connectionFields)))

const channelSchema = Schema.Struct({
  confirm: Schema.optionalKey(Schema.Boolean),
  confirmTimeout: Schema.optionalKey(duration),
  waitChannelTimeout: Schema.optionalKey(duration),
  maxUnconfirmed: Schema.optionalKey(Protocol.unsigned(65535)),
  prefetch: Schema.optionalKey(Protocol.unsigned(65535))
})
export const channel = Schema.decodeUnknownEffect(snapshot(channelSchema, Object.keys(channelSchema.fields)))

const deletionSchema = Schema.Struct({
  ifUnused: Schema.optionalKey(Schema.Boolean),
  ifEmpty: Schema.optionalKey(Schema.Boolean)
})
export const queueDeletion = Schema.decodeUnknownEffect(snapshot(deletionSchema, Object.keys(deletionSchema.fields)))
const exchangeDeletionSchema = Schema.Struct({ ifUnused: Schema.optionalKey(Schema.Boolean) })
export const exchangeDeletion = Schema.decodeUnknownEffect(snapshot(exchangeDeletionSchema, ["ifUnused"]))

/** Shallow TLS/transport records retain buffers and callbacks, including inherited options. @internal */
export const record = Effect.fnUntraced(function*(input: object) {
  const invalid = () => new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "Invalid transport options" }))
  const names = new Set<string>()
  const seen = new Set<object>()
  let current: object | null = input
  while (current !== null && current !== Object.prototype) {
    if (seen.size >= 36 || seen.has(current)) return yield* Effect.fail(invalid())
    seen.add(current)
    const owner: object = current
    const properties = yield* Effect.try({ try: () => Object.getOwnPropertyNames(owner), catch: invalid })
    for (const name of properties) {
      if (name !== "constructor") names.add(name)
      if (names.size * 32 > Protocol.MAX_VALUE_BYTES) return yield* Effect.fail(invalid())
    }
    current = yield* Effect.try({ try: (): object | null => Object.getPrototypeOf(owner), catch: invalid })
  }
  return yield* Schema.decodeUnknownEffect(snapshot(Schema.Record(Schema.String, Schema.Unknown), Array.from(names)))(
    input
  )
})
