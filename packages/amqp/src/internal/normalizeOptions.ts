import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AMQPProtocolError } from "../AMQPError.ts"
import type * as AMQPTypes from "../AMQPTypes.ts"
import * as Protocol from "./protocol.ts"

const optional = Protocol.optionalInputProperty
const count = Protocol.unsigned(Number.MAX_SAFE_INTEGER)
const queueAliases = {
  messageTtl: "x-message-ttl",
  expires: "x-expires",
  deadLetterExchange: "x-dead-letter-exchange",
  deadLetterRoutingKey: "x-dead-letter-routing-key",
  maxLength: "x-max-length",
  maxLengthBytes: "x-max-length-bytes",
  maxPriority: "x-max-priority",
  overflow: "x-overflow",
  singleActiveConsumer: "x-single-active-consumer",
  queueMode: "x-queue-mode",
  queueType: "x-queue-type",
  consumerTimeout: "x-consumer-timeout"
} as const
const queueSchema = Schema.StructWithRest(
  Schema.Struct({
    durable: optional(Schema.Boolean),
    exclusive: optional(Schema.Boolean),
    autoDelete: optional(Schema.Boolean),
    arguments: optional(Protocol.fieldTableShape),
    messageTtl: optional(count),
    expires: optional(count),
    deadLetterExchange: optional(Protocol.text),
    deadLetterRoutingKey: optional(Protocol.text),
    maxLength: optional(count),
    maxLengthBytes: optional(count),
    maxPriority: optional(Protocol.unsigned(255)),
    overflow: optional(Protocol.text),
    singleActiveConsumer: optional(Schema.Boolean),
    queueMode: optional(Protocol.text),
    queueType: optional(Protocol.text),
    consumerTimeout: optional(count)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
const exchangeSchema = Schema.StructWithRest(
  Schema.Struct({
    durable: optional(Schema.Boolean),
    autoDelete: optional(Schema.Boolean),
    internal: optional(Schema.Boolean),
    arguments: optional(Protocol.fieldTableShape),
    alternateExchange: optional(Protocol.text)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
const routing = Schema.Union([Protocol.text, Schema.Array(Protocol.text)])
const publishSchema = Schema.StructWithRest(
  Schema.Struct({
    mandatory: optional(Schema.Boolean),
    persistent: optional(Schema.Boolean),
    CC: optional(routing),
    BCC: optional(routing)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
const decode = Effect.fnUntraced(
  function*<A, E>(schema: Schema.Codec<A, E>, input: unknown, names: ReadonlyArray<string>) {
    const snapshot = yield* Protocol.snapshotNamedInput(input, names).pipe(
      Effect.mapError((issue) =>
        new AMQPProtocolError({ reason: "Invalid AMQP options", cause: new Schema.SchemaError(issue) })
      )
    )
    return yield* Schema.decodeUnknownEffect(schema)(snapshot).pipe(Effect.mapError(tableError))
  }
)
const dictionary = (input: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> =>
  Object.assign(Object.create(null), input)
const validateTable = Protocol.snapshotFieldTable
const tableError = (cause: Schema.SchemaError) => new AMQPProtocolError({ reason: "Invalid AMQP options", cause })

/** Convenience aliases override raw arguments whenever defined, including zero/false. @since 1.0.0-beta.0 */
export const queue = Effect.fnUntraced(function*(options: AMQPTypes.QueueOptions) {
  const normalized = yield* decode(queueSchema, options, [
    "durable",
    "exclusive",
    "autoDelete",
    "arguments",
    ...Object.keys(queueAliases)
  ])
  const arguments_ = dictionary(normalized.arguments)
  for (const [alias, key] of Object.entries(queueAliases)) {
    const value = normalized[alias as keyof typeof queueAliases]
    if (value !== undefined) arguments_[key] = value
  }
  const argumentsTable = yield* validateTable(arguments_)
  return { ...normalized, arguments: argumentsTable } satisfies AMQPTypes.QueueOptions
})

/** Convenience alternateExchange takes precedence over raw alternate-exchange. @since 1.0.0-beta.0 */
export const exchange = Effect.fnUntraced(function*(options: AMQPTypes.ExchangeOptions) {
  const normalized = yield* decode(exchangeSchema, options, [
    "durable",
    "autoDelete",
    "internal",
    "arguments",
    "alternateExchange"
  ])
  const arguments_ = dictionary(normalized.arguments)
  if (normalized.alternateExchange !== undefined) arguments_["alternate-exchange"] = normalized.alternateExchange
  const argumentsTable = yield* validateTable(arguments_)
  return { ...normalized, arguments: argumentsTable } satisfies AMQPTypes.ExchangeOptions
})

/**
 * amqplib-compatible CC/BCC header precedence and persistent delivery mode.
 * Routing arrays preserve ordering and duplicates; strings use the S wire scalar.
 * BCC is sent to the broker, which strips it before delivery.
 * @since 1.0.0-beta.0
 */
export const publish = Effect.fnUntraced(function*(options: AMQPTypes.PublishOptions) {
  const normalized = yield* decode(publishSchema, options, [
    "mandatory",
    "persistent",
    "CC",
    "BCC",
    ...Protocol.messageProperties.map(([name]) => name)
  ])
  const rawHeaders = yield* Schema.decodeUnknownEffect(Protocol.fieldTableShape)(normalized.headers ?? {}).pipe(
    Effect.mapError(tableError)
  )
  const headers = dictionary(rawHeaders)
  const hasHeaders = normalized.headers !== undefined || normalized.CC !== undefined || normalized.BCC !== undefined
  for (const key of ["CC", "BCC"] as const) {
    const value = normalized[key]
    if (value !== undefined) headers[key] = typeof value === "string" ? [value] : value
  }
  // Parse only our owned snapshot, after conveniences replace the raw wire values.
  const properties = yield* Schema.decodeUnknownEffect(Protocol.inputPropertiesSchema)({
    ...normalized,
    ...(normalized.persistent === undefined ? {} : { deliveryMode: normalized.persistent ? 2 : 1 }),
    ...(hasHeaders ? { headers } : {})
  }).pipe(Effect.mapError(tableError))
  return {
    ...properties,
    ...(normalized.mandatory === undefined ? {} : { mandatory: normalized.mandatory }),
    ...(normalized.persistent === undefined ? {} : { persistent: normalized.persistent }),
    ...(normalized.CC === undefined ? {} : { CC: normalized.CC }),
    ...(normalized.BCC === undefined ? {} : { BCC: normalized.BCC })
  } satisfies AMQPTypes.PublishOptions
})

const consumeSchema = Schema.Struct({
  prefetch: optional(Protocol.unsigned(65535)),
  noAck: optional(Schema.Boolean),
  noLocal: optional(Schema.Boolean),
  maxBufferedMessages: optional(count.check(Schema.isGreaterThan(0))),
  priority: optional(
    Schema.Int.check(Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }))
  ),
  exclusive: optional(Schema.Boolean),
  consumerTag: optional(Protocol.short),
  arguments: optional(Protocol.fieldTableShape)
})
/** Consumer priority overrides raw x-priority; local buffering is independent of wire QoS. @since 1.0.0-beta.0 */
export const consume = Effect.fnUntraced(function*(options: AMQPTypes.ConsumeOptions) {
  const normalized = yield* decode(consumeSchema, options, Object.keys(consumeSchema.fields))
  const arguments_ = dictionary(normalized.arguments)
  if (normalized.priority !== undefined) arguments_["x-priority"] = normalized.priority
  const argumentsTable = yield* validateTable(arguments_)
  return { ...normalized, arguments: argumentsTable } satisfies AMQPTypes.ConsumeOptions
})
