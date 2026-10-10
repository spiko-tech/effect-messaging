import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { AMQPProtocolError } from "../AMQPError.ts"
import * as AMQPTypes from "../AMQPTypes.ts"
import type * as Codec from "./codec.ts"

/** @since 0.8.0 */
export type FieldKind = "u8" | "u16" | "u32" | "u64" | "short" | "text" | "bytes" | "table" | "bit"

/**
 * Stable descriptors can be compared by reference after lookup. Fields are in wire
 * order; consecutive bits share an octet. Replies describe synchronous exchanges
 * when noWait is false, not unsolicited controls or publisher confirmations.
 * @since 0.8.0
 */
export interface MethodDescriptor {
  readonly name: string
  readonly classId: number
  readonly methodId: number
  readonly fields: ReadonlyArray<readonly [string, FieldKind]>
  readonly replies: ReadonlyArray<MethodDescriptor>
}

const define = (
  name: string,
  classId: number,
  methodId: number,
  description = "",
  replies: () => ReadonlyArray<MethodDescriptor> = () => []
): MethodDescriptor => {
  let expected: ReadonlyArray<MethodDescriptor> | undefined
  const fields = description === "" ? [] : description.split(" ").map((field) => {
    const [fieldName, kind] = field.split(":")
    return Object.freeze([fieldName, kind as FieldKind] as const)
  })
  return Object.freeze({
    name,
    classId,
    methodId,
    fields: Object.freeze(fields),
    get replies() {
      return expected ??= Object.freeze(replies())
    }
  })
}

/** @since 0.8.0 */
export const ConnectionStart = define(
  "ConnectionStart",
  10,
  10,
  "versionMajor:u8 versionMinor:u8 serverProperties:table mechanisms:text locales:text"
)
/** @since 0.8.0 */
export const ConnectionStartOk = define(
  "ConnectionStartOk",
  10,
  11,
  "clientProperties:table mechanism:short response:bytes locale:short",
  () => [ConnectionTune]
)
// ConnectionSecure (10:20) remains unsupported, as in the original codec.
/** @since 0.8.0 */
export const ConnectionTune = define("ConnectionTune", 10, 30, "channelMax:u16 frameMax:u32 heartbeat:u16")
/** @since 0.8.0 */
export const ConnectionTuneOk = define("ConnectionTuneOk", 10, 31, "channelMax:u16 frameMax:u32 heartbeat:u16")
/** @since 0.8.0 */
export const ConnectionOpen = define(
  "ConnectionOpen",
  10,
  40,
  "virtualHost:short reserved1:short outOfBand:bit",
  () => [ConnectionOpenOk]
)
/** @since 0.8.0 */
export const ConnectionOpenOk = define("ConnectionOpenOk", 10, 41, "reserved1:short")
/** @since 0.8.0 */
export const ConnectionClose = define(
  "ConnectionClose",
  10,
  50,
  "replyCode:u16 replyText:short classId:u16 methodId:u16",
  () => [ConnectionCloseOk]
)
/** @since 0.8.0 */
export const ConnectionCloseOk = define("ConnectionCloseOk", 10, 51)
/** @since 0.8.0 */
export const ConnectionBlocked = define("ConnectionBlocked", 10, 60, "reason:short")
/** @since 0.8.0 */
export const ConnectionUnblocked = define("ConnectionUnblocked", 10, 61)
/** @since 0.8.0 */
export const ConnectionUpdateSecret = define(
  "ConnectionUpdateSecret",
  10,
  70,
  "newSecret:bytes reason:short",
  () => [ConnectionUpdateSecretOk]
)
/** @since 0.8.0 */
export const ConnectionUpdateSecretOk = define("ConnectionUpdateSecretOk", 10, 71)
/** @since 0.8.0 */
export const ChannelOpen = define("ChannelOpen", 20, 10, "reserved1:short", () => [ChannelOpenOk])
/** @since 0.8.0 */
export const ChannelOpenOk = define("ChannelOpenOk", 20, 11, "reserved1:text")
/** @since 0.8.0 */
export const ChannelFlow = define("ChannelFlow", 20, 20, "active:bit", () => [ChannelFlowOk])
/** @since 0.8.0 */
export const ChannelFlowOk = define("ChannelFlowOk", 20, 21, "active:bit")
/** @since 0.8.0 */
export const ChannelClose = define(
  "ChannelClose",
  20,
  40,
  "replyCode:u16 replyText:short classId:u16 methodId:u16",
  () => [ChannelCloseOk]
)
/** @since 0.8.0 */
export const ChannelCloseOk = define("ChannelCloseOk", 20, 41)
/** @since 0.8.0 */
export const ExchangeDeclare = define(
  "ExchangeDeclare",
  40,
  10,
  "reserved1:u16 exchange:short type:short passive:bit durable:bit autoDelete:bit internal:bit noWait:bit arguments:table",
  () => [ExchangeDeclareOk]
)
/** @since 0.8.0 */
export const ExchangeDeclareOk = define("ExchangeDeclareOk", 40, 11)
/** @since 0.8.0 */
export const ExchangeDelete = define(
  "ExchangeDelete",
  40,
  20,
  "reserved1:u16 exchange:short ifUnused:bit noWait:bit",
  () => [ExchangeDeleteOk]
)
/** @since 0.8.0 */
export const ExchangeDeleteOk = define("ExchangeDeleteOk", 40, 21)
/** @since 0.8.0 */
export const ExchangeBind = define(
  "ExchangeBind",
  40,
  30,
  "reserved1:u16 destination:short source:short routingKey:short noWait:bit arguments:table",
  () => [ExchangeBindOk]
)
/** @since 0.8.0 */
export const ExchangeBindOk = define("ExchangeBindOk", 40, 31)
/** @since 0.8.0 */
export const ExchangeUnbind = define(
  "ExchangeUnbind",
  40,
  40,
  "reserved1:u16 destination:short source:short routingKey:short noWait:bit arguments:table",
  () => [ExchangeUnbindOk]
)
/** @since 0.8.0 */
export const ExchangeUnbindOk = define("ExchangeUnbindOk", 40, 51)
/** @since 0.8.0 */
export const QueueDeclare = define(
  "QueueDeclare",
  50,
  10,
  "reserved1:u16 queue:short passive:bit durable:bit exclusive:bit autoDelete:bit noWait:bit arguments:table",
  () => [QueueDeclareOk]
)
/** @since 0.8.0 */
export const QueueDeclareOk = define("QueueDeclareOk", 50, 11, "queue:short messageCount:u32 consumerCount:u32")
/** @since 0.8.0 */
export const QueueBind = define(
  "QueueBind",
  50,
  20,
  "reserved1:u16 queue:short exchange:short routingKey:short noWait:bit arguments:table",
  () => [QueueBindOk]
)
/** @since 0.8.0 */
export const QueueBindOk = define("QueueBindOk", 50, 21)
/** @since 0.8.0 */
export const QueuePurge = define("QueuePurge", 50, 30, "reserved1:u16 queue:short noWait:bit", () => [QueuePurgeOk])
/** @since 0.8.0 */
export const QueuePurgeOk = define("QueuePurgeOk", 50, 31, "messageCount:u32")
/** @since 0.8.0 */
export const QueueDelete = define(
  "QueueDelete",
  50,
  40,
  "reserved1:u16 queue:short ifUnused:bit ifEmpty:bit noWait:bit",
  () => [QueueDeleteOk]
)
/** @since 0.8.0 */
export const QueueDeleteOk = define("QueueDeleteOk", 50, 41, "messageCount:u32")
/** @since 0.8.0 */
export const QueueUnbind = define(
  "QueueUnbind",
  50,
  50,
  "reserved1:u16 queue:short exchange:short routingKey:short arguments:table",
  () => [QueueUnbindOk]
)
/** @since 0.8.0 */
export const QueueUnbindOk = define("QueueUnbindOk", 50, 51)
/** @since 0.8.0 */
export const BasicQos = define("BasicQos", 60, 10, "prefetchSize:u32 prefetchCount:u16 global:bit", () => [BasicQosOk])
/** @since 0.8.0 */
export const BasicQosOk = define("BasicQosOk", 60, 11)
/** @since 0.8.0 */
export const BasicConsume = define(
  "BasicConsume",
  60,
  20,
  "reserved1:u16 queue:short consumerTag:short noLocal:bit noAck:bit exclusive:bit noWait:bit arguments:table",
  () => [BasicConsumeOk]
)
/** @since 0.8.0 */
export const BasicConsumeOk = define("BasicConsumeOk", 60, 21, "consumerTag:short")
/** @since 0.8.0 */
export const BasicCancel = define("BasicCancel", 60, 30, "consumerTag:short noWait:bit", () => [BasicCancelOk])
/** @since 0.8.0 */
export const BasicCancelOk = define("BasicCancelOk", 60, 31, "consumerTag:short")
/** @since 0.8.0 */
export const BasicPublish = define(
  "BasicPublish",
  60,
  40,
  "reserved1:u16 exchange:short routingKey:short mandatory:bit immediate:bit"
)
/** @since 0.8.0 */
export const BasicReturn = define(
  "BasicReturn",
  60,
  50,
  "replyCode:u16 replyText:short exchange:short routingKey:short"
)
/** @since 0.8.0 */
export const BasicDeliver = define(
  "BasicDeliver",
  60,
  60,
  "consumerTag:short deliveryTag:u64 redelivered:bit exchange:short routingKey:short"
)
/** @since 0.8.0 */
export const BasicGet = define(
  "BasicGet",
  60,
  70,
  "reserved1:u16 queue:short noAck:bit",
  () => [BasicGetOk, BasicGetEmpty]
)
/** @since 0.8.0 */
export const BasicGetOk = define(
  "BasicGetOk",
  60,
  71,
  "deliveryTag:u64 redelivered:bit exchange:short routingKey:short messageCount:u32"
)
/** @since 0.8.0 */
export const BasicGetEmpty = define("BasicGetEmpty", 60, 72, "reserved1:short")
/** @since 0.8.0 */
export const BasicAck = define("BasicAck", 60, 80, "deliveryTag:u64 multiple:bit")
/** @since 0.8.0 */
export const BasicReject = define("BasicReject", 60, 90, "deliveryTag:u64 requeue:bit")
/** @since 0.8.0 */
export const BasicRecoverAsync = define("BasicRecoverAsync", 60, 100, "requeue:bit")
/** @since 0.8.0 */
export const BasicRecover = define("BasicRecover", 60, 110, "requeue:bit", () => [BasicRecoverOk])
/** @since 0.8.0 */
export const BasicRecoverOk = define("BasicRecoverOk", 60, 111)
/** @since 0.8.0 */
export const BasicNack = define("BasicNack", 60, 120, "deliveryTag:u64 multiple:bit requeue:bit")
/** @since 0.8.0 */
export const ConfirmSelect = define("ConfirmSelect", 85, 10, "noWait:bit", () => [ConfirmSelectOk])
/** @since 0.8.0 */
export const ConfirmSelectOk = define("ConfirmSelectOk", 85, 11)

/** The complete supported method vocabulary. @since 0.8.0 */
export const methods = Object.freeze({
  ConnectionStart,
  ConnectionStartOk,
  ConnectionTune,
  ConnectionTuneOk,
  ConnectionOpen,
  ConnectionOpenOk,
  ConnectionClose,
  ConnectionCloseOk,
  ConnectionBlocked,
  ConnectionUnblocked,
  ConnectionUpdateSecret,
  ConnectionUpdateSecretOk,
  ChannelOpen,
  ChannelOpenOk,
  ChannelFlow,
  ChannelFlowOk,
  ChannelClose,
  ChannelCloseOk,
  ExchangeDeclare,
  ExchangeDeclareOk,
  ExchangeDelete,
  ExchangeDeleteOk,
  ExchangeBind,
  ExchangeBindOk,
  ExchangeUnbind,
  ExchangeUnbindOk,
  QueueDeclare,
  QueueDeclareOk,
  QueueBind,
  QueueBindOk,
  QueuePurge,
  QueuePurgeOk,
  QueueDelete,
  QueueDeleteOk,
  QueueUnbind,
  QueueUnbindOk,
  BasicQos,
  BasicQosOk,
  BasicConsume,
  BasicConsumeOk,
  BasicCancel,
  BasicCancelOk,
  BasicPublish,
  BasicReturn,
  BasicDeliver,
  BasicGet,
  BasicGetOk,
  BasicGetEmpty,
  BasicAck,
  BasicReject,
  BasicRecoverAsync,
  BasicRecover,
  BasicRecoverOk,
  BasicNack,
  ConfirmSelect,
  ConfirmSelectOk
})

const byId = new Map(Object.values(methods).map((method) => [`${method.classId}:${method.methodId}`, method]))

/** Fails with AMQPProtocolError for unsupported methods. @since 0.8.0 */
export const lookup = Effect.fnUntraced(function*(
  classId: number,
  methodId: number
): Effect.fn.Return<MethodDescriptor, AMQPProtocolError> {
  const method = byId.get(`${classId}:${methodId}`)
  if (method === undefined) {
    return yield* new AMQPProtocolError({ reason: `Unsupported method ${classId}:${methodId}` })
  }
  return method
})

/** Shared integer constraints for method fields, properties and frame envelopes. @since 1.0.0-beta.0 */
export const unsigned = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))
/** Hard cap shared by binary transformations and allocation-free text validation. @since 1.0.0-beta.0 */
export const MAX_VALUE_BYTES = 16 * 1024 * 1024
/** @since 1.0.0-beta.0 */
export const unsigned64 = Schema.BigInt.check(Schema.isBetweenBigInt({
  minimum: BigInt(0),
  maximum: BigInt("18446744073709551615")
}))
const signed64 = Schema.BigInt.check(Schema.isBetweenBigInt({
  minimum: BigInt("-9223372036854775808"),
  maximum: BigInt("9223372036854775807")
}))
/** Safe numbers may be supplied by callers; decoded unsigned long-long values are always bigint. @since 1.0.0-beta.0 */
export const unsigned64Input = Schema.Union([unsigned64, unsigned(Number.MAX_SAFE_INTEGER)]).pipe(
  Schema.decodeTo(
    unsigned64,
    SchemaTransformation.transform({
      decode: (value) => typeof value === "bigint" ? value : BigInt(value),
      encode: (value) => value
    })
  )
)
const bytesInput = Schema.Union([Schema.Uint8Array, Schema.suspend(() => text)]).pipe(
  Schema.decodeTo(
    Schema.Uint8Array,
    SchemaTransformation.transform({
      decode: (value) => typeof value === "string" ? new TextEncoder().encode(value) : value,
      encode: (value) => value
    })
  )
)

// Count UTF-8 bytes without allocating, and reject the lone surrogates that TextEncoder would replace.
const utf8Length = (value: string): number => {
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return -1
      length += 4
    } else if (code >= 0xdc00 && code <= 0xdfff) return -1
    else length += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
  }
  return length
}

/** Lossless UTF-8 text, shared by method fields and field-table scalars. @since 1.0.0-beta.0 */
export const text = Schema.String.check(
  Schema.makeFilter((value) => utf8Length(value) >= 0, {
    message: "Invalid UTF-16 string"
  }),
  Schema.makeFilter((value) => utf8Length(value) <= MAX_VALUE_BYTES, {
    message: "Encoded value exceeds size limit"
  })
)
/** AMQP short strings are limited by encoded bytes, not JavaScript characters. @since 1.0.0-beta.0 */
export const short = text.check(
  Schema.makeFilter((value) => utf8Length(value) <= 255, { message: "Short string exceeds 255 UTF-8 bytes" }),
  Schema.makeFilter((value) => !value.includes("\u0000"), { message: "Short string contains a zero octet" })
)
const decimal = Schema.Struct({
  [AMQPTypes.DecimalTypeId]: Schema.UniqueSymbol(AMQPTypes.DecimalTypeId),
  _tag: Schema.Literal("Decimal"),
  scale: unsigned(255),
  value: unsigned(0xffffffff)
})
const fieldNumber = Schema.Struct({
  [AMQPTypes.FieldNumberTypeId]: Schema.UniqueSymbol(AMQPTypes.FieldNumberTypeId),
  type: Schema.Literals(["float", "double"]),
  value: Schema.Finite
}).check(Schema.makeFilter((value) => value.type !== "float" || Number.isFinite(Math.fround(value.value))))
const longString = Schema.Struct({
  [AMQPTypes.LongStringTypeId]: Schema.UniqueSymbol(AMQPTypes.LongStringTypeId),
  bytes: Schema.Uint8Array
})
const timestamp = Schema.Date.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value.getTime()) && value.getTime() >= 0)
)

// Reflection and property access on caller-owned containers may invoke proxy traps or getters.
const accessContainer = <A>(access: () => A, message: string): Effect.Effect<A, SchemaIssue.Issue> =>
  Effect.try({
    try: access,
    catch: (cause) => SchemaIssue.isIssue(cause) ? cause : new SchemaIssue.InvalidValue({ message, actual: cause })
  })

// Validate containers in place. Parsing Record/Array would allocate an unbudgeted second graph.
const fieldArray = <A>(value: Schema.Codec<A>): Schema.Codec<ReadonlyArray<A>> =>
  Schema.declareConstructor<ReadonlyArray<A>>()([value], ([codec]) => {
    const decode = SchemaParser.decodeUnknownEffect(codec)
    return Effect.fnUntraced(function*(input: unknown, ast: SchemaAST.Declaration, options: SchemaAST.ParseOptions) {
      const isArray = yield* accessContainer(() => Array.isArray(input), "Invalid field array")
      if (!isArray) return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
      const array = input as ReadonlyArray<unknown>
      for (let i = 0; i < (yield* accessContainer(() => array.length, "Invalid field array")); i++) {
        const entry = yield* accessContainer(() => array[i], "Invalid field array")
        yield* decode(entry, options).pipe(Effect.mapError((issue) => new SchemaIssue.Pointer([i], issue)))
      }
      return array as ReadonlyArray<A>
    })
  })

const fieldRecord = <A>(value: Schema.Codec<A>): Schema.Codec<Readonly<Record<string, A>>> =>
  Schema.declareConstructor<Readonly<Record<string, A>>>()([short, value], ([keyCodec, valueCodec]) => {
    const decodeKey = SchemaParser.decodeUnknownEffect(keyCodec)
    const decodeValue = SchemaParser.decodeUnknownEffect(valueCodec)
    return Effect.fnUntraced(function*(input: unknown, ast: SchemaAST.Declaration, options: SchemaAST.ParseOptions) {
      if (!Predicate.isObject(input)) return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
      const prototype = yield* accessContainer(() => Object.getPrototypeOf(input), "Invalid field table")
      if (prototype !== null && prototype !== Object.prototype) {
        return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
      }
      const isWrapper = yield* accessContainer(() =>
        Predicate.hasProperty(input, AMQPTypes.DecimalTypeId) ||
        Predicate.hasProperty(input, AMQPTypes.FieldNumberTypeId) ||
        Predicate.hasProperty(input, AMQPTypes.LongStringTypeId), "Invalid field table")
      if (isWrapper) return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
      const keys = yield* accessContainer(() => Object.keys(input), "Invalid field table")
      for (const key of keys) {
        yield* decodeKey(key, options).pipe(Effect.mapError((issue) => new SchemaIssue.Pointer([key], issue)))
        const entry = yield* accessContainer(() => input[key], "Invalid field table")
        yield* decodeValue(entry, options).pipe(Effect.mapError((issue) => new SchemaIssue.Pointer([key], issue)))
      }
      // Every own entry has been validated without replacing its identity or prototype.
      return input as Readonly<Record<string, A>>
    })
  })

// Depth counts field values, including scalar leaves, exactly as the wire codec does.
const tables = new Map<number, Schema.Codec<AMQPTypes.FieldTable>>()
const fieldValues = new Map<number, Schema.Codec<AMQPTypes.FieldValue>>()
const fieldValue = (depth: number): Schema.Codec<AMQPTypes.FieldValue> => {
  const cached = fieldValues.get(depth)
  if (cached !== undefined) return cached
  const schema = depth > 32 ? Schema.Never : Schema.Union([
    text,
    Schema.Finite,
    signed64,
    Schema.Boolean,
    Schema.Null,
    Schema.Uint8Array,
    timestamp,
    decimal,
    fieldNumber,
    longString,
    fieldArray(Schema.suspend(() => fieldValue(depth + 1))),
    Schema.suspend(() => table(depth))
  ])
  fieldValues.set(depth, schema)
  return schema
}
const table = (depth: number): Schema.Codec<AMQPTypes.FieldTable> => {
  const cached = tables.get(depth)
  if (cached !== undefined) return cached
  // User table keys, including _tag, are not reserved as scalar discriminants.
  const schema = depth > 32 ?
    Schema.Never :
    fieldRecord(Schema.suspend(() => fieldValue(depth + 1)))
  tables.set(depth, schema)
  return schema
}

/** Identity-preserving validation for both wire directions, bounded to the parser's nesting limit. @since 1.0.0-beta.0 */
export const fieldTable = table(0)

/** Wire value constraints shared by encoding and decoding. @since 1.0.0-beta.0 */
export const fieldSchemas = {
  u8: unsigned(255),
  u16: unsigned(65535),
  u32: unsigned(0xffffffff),
  u64: unsigned64,
  short,
  text,
  bytes: Schema.Uint8Array,
  table: fieldTable,
  bit: Schema.Boolean
} satisfies Record<FieldKind, Schema.Codec<AMQPTypes.FieldValue>>

/** Decoded method fields validated from the descriptor's wire definition. @since 0.8.0 */
export type Fields = Record<string, AMQPTypes.FieldValue>

const fieldDecoders = new WeakMap<
  MethodDescriptor,
  (input: unknown) => Effect.Effect<Fields, Schema.SchemaError>
>()

const fieldContracts = new WeakMap<MethodDescriptor, Schema.Codec<Fields>>()
const inputFieldContracts = new WeakMap<MethodDescriptor, Schema.Codec<Fields, unknown>>()
const fieldObject = Schema.declare((value: unknown): value is Fields => {
  if (!Predicate.isObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
})

/** Complete wire fields; defaults must never conceal missing decoded data. @since 1.0.0-beta.0 */
export const fieldsSchema = (descriptor: MethodDescriptor): Schema.Codec<Fields> => {
  const cached = fieldContracts.get(descriptor)
  if (cached !== undefined) return cached
  const fields: Record<string, Schema.Codec<AMQPTypes.FieldValue>> = {}
  for (const [name, kind] of descriptor.fields) fields[name] = fieldSchemas[kind]
  const schema = fieldObject.pipe(Schema.decodeTo(
    descriptor.fields.length === 0 ? Schema.Record(Schema.String, Schema.Never) : Schema.Struct(fields)
  )).check(Schema.makeFilter(Schema.is(fieldObject)))
  fieldContracts.set(descriptor, schema)
  return schema
}

/** Normalize only outgoing convenience inputs, sharing the complete wire constraints. @since 1.0.0-beta.0 */
export const inputFieldsSchema = (descriptor: MethodDescriptor): Schema.Codec<Fields, unknown> => {
  const cached = inputFieldContracts.get(descriptor)
  if (cached !== undefined) return cached
  const fields: Record<string, Schema.Codec<AMQPTypes.FieldValue, unknown>> = {}
  for (const [name, kind] of descriptor.fields) {
    const schema = kind === "u64" ? unsigned64Input : kind === "bytes" ? bytesInput : fieldSchemas[kind]
    const fallback = kind === "table" ? Effect.sync(() => ({})) : Effect.succeed(
      kind === "bit" ? false : kind === "short" || kind === "text" ? "" : kind === "bytes" ?
        new Uint8Array() :
        kind === "u64"
        ? BigInt(0)
        : 0
    )
    fields[name] = schema.pipe(Schema.withDecodingDefaultKey(fallback))
  }
  const schema: Schema.Codec<Fields, unknown> = fieldObject.pipe(Schema.decodeTo(
    descriptor.fields.length === 0 ? Schema.Record(Schema.String, Schema.Never) : Schema.Struct(fields)
  ))
  inputFieldContracts.set(descriptor, schema)
  return schema
}

/** Validate unknown decoded fields without interpreting the AMQP binary format. @since 0.8.0 */
export const decodeFields = (
  descriptor: MethodDescriptor,
  input: unknown
): Effect.Effect<Fields, AMQPProtocolError> => {
  let decode = fieldDecoders.get(descriptor)
  if (decode === undefined) {
    decode = Schema.decodeUnknownEffect(fieldsSchema(descriptor), { onExcessProperty: "error" })
    fieldDecoders.set(descriptor, decode)
  }
  return decode(input).pipe(Effect.mapError((cause) =>
    new AMQPProtocolError({
      reason: `Invalid ${descriptor.name} fields`,
      cause
    })
  ))
}

const stringDecoder = Schema.decodeUnknownEffect(Schema.String)
const numberDecoder = Schema.decodeUnknownEffect(Schema.Finite)
const bigintDecoder = Schema.decodeUnknownEffect(unsigned64)
const tableDecoder = Schema.decodeUnknownEffect(fieldTable)

const readField = <A>(
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  method: Codec.Method,
  key: string
): Effect.Effect<A, AMQPProtocolError> =>
  decode(method.fields[key]).pipe(
    Effect.mapError((cause) => new AMQPProtocolError({ reason: `Invalid ${key} field`, cause }))
  )

/** @since 0.8.0 */
export const readString = (method: Codec.Method, key: string): Effect.Effect<string, AMQPProtocolError> =>
  readField(stringDecoder, method, key)

/** @since 0.8.0 */
export const readNumber = (method: Codec.Method, key: string): Effect.Effect<number, AMQPProtocolError> =>
  readField(numberDecoder, method, key)

/** @since 0.8.0 */
export const readBigInt = (method: Codec.Method, key: string): Effect.Effect<bigint, AMQPProtocolError> =>
  readField(bigintDecoder, method, key)

/** @since 0.8.0 */
export const readTable = (method: Codec.Method, key: string): Effect.Effect<AMQPTypes.FieldTable, AMQPProtocolError> =>
  readField(tableDecoder, method, key)

/** @since 0.8.0 */
export const queueReply = Effect.fnUntraced(function*(
  method: Codec.Method
): Effect.fn.Return<AMQPTypes.QueueReply, AMQPProtocolError> {
  return {
    queue: yield* readString(method, "queue"),
    messageCount: yield* readNumber(method, "messageCount"),
    consumerCount: yield* readNumber(method, "consumerCount")
  }
})
