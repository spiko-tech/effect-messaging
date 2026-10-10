import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { AMQPProtocolError } from "../AMQPError.ts"
import * as AMQPTypes from "../AMQPTypes.ts"
import * as Protocol from "./protocol.ts"

/** @since 0.8.0 */
export interface Frame {
  readonly type: number
  readonly channel: number
  readonly payload: Uint8Array
}

/** @since 0.8.0 */
export interface Method {
  readonly classId: number
  readonly methodId: number
  readonly fields: Record<string, AMQPTypes.FieldValue>
}

export const PROTOCOL_HEADER = new Uint8Array([65, 77, 81, 80, 0, 0, 9, 1])
const MAX_VALUE_BYTES = Protocol.MAX_VALUE_BYTES
const MAX_DEPTH = 32
/** Conservative retained-memory accounting, not a JS heap measurement. @since 0.8.0 */
export const MAX_DECODED_BYTES = 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const invalid = (message: string) => Effect.fail(new SchemaIssue.InvalidValue({ message }))
const protocolError = (cause: Schema.SchemaError) => new AMQPProtocolError({ reason: cause.message, cause })

const wireCodec = <A>(
  model: Schema.Codec<A>,
  read: (bytes: Uint8Array) => Effect.Effect<A, SchemaIssue.Issue>,
  write: (value: A) => Effect.Effect<Uint8Array, SchemaIssue.Issue>
): Schema.Codec<A, Uint8Array> =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(model, SchemaTransformation.transformEffect<A, Uint8Array>({ decode: read, encode: write }))
  )
const boundary = <A>(schema: Schema.Codec<A, Uint8Array>) => {
  const encode = Schema.encodeUnknownEffect(schema)
  const decode = Schema.decodeUnknownEffect(schema)
  return {
    encode: (value: A) => encode(value).pipe(Effect.mapError(protocolError)),
    decode: (bytes: Uint8Array) => decode(bytes).pipe(Effect.mapError(protocolError))
  }
}

// The schemas own value constraints; the writer only owns bounded storage and wire layout.
class Writer {
  private bytes = new Uint8Array(128)
  private view = new DataView(this.bytes.buffer)
  private length = 0

  private reserve(size: number): Effect.Effect<number, SchemaIssue.Issue> {
    return Effect.suspend(() => {
      if (size > MAX_VALUE_BYTES - this.length) return invalid("Encoded value exceeds size limit")
      const start = this.length
      const length = start + size
      if (length > this.bytes.length) {
        const bytes = new Uint8Array(Math.min(MAX_VALUE_BYTES, Math.max(length, this.bytes.length * 2)))
        bytes.set(this.bytes.subarray(0, start))
        this.bytes = bytes
        this.view = new DataView(bytes.buffer)
      }
      this.length = length
      return Effect.succeed(start)
    })
  }
  u8(value: number) {
    return Effect.map(this.reserve(1), (offset) => this.view.setUint8(offset, value))
  }
  u16(value: number) {
    return Effect.map(this.reserve(2), (offset) => this.view.setUint16(offset, value))
  }
  u32(value: number) {
    return Effect.map(this.reserve(4), (offset) => this.view.setUint32(offset, value))
  }
  u64(value: bigint) {
    return Effect.map(this.reserve(8), (offset) => this.view.setBigUint64(offset, value))
  }
  signed(value: number | bigint, size: number) {
    return Effect.map(this.reserve(size), (offset) => {
      if (size === 1) this.view.setInt8(offset, Number(value))
      else if (size === 2) this.view.setInt16(offset, Number(value))
      else if (size === 4) this.view.setInt32(offset, Number(value))
      else this.view.setBigInt64(offset, typeof value === "bigint" ? value : BigInt(value))
    })
  }
  float(value: number, size = 8) {
    return Effect.map(this.reserve(size), (offset) => {
      if (size === 4) this.view.setFloat32(offset, value)
      else this.view.setFloat64(offset, value)
    })
  }
  raw(value: Uint8Array) {
    return Effect.map(this.reserve(value.length), (offset) => this.bytes.set(value, offset))
  }
  short(value: string) {
    return Effect.suspend(() => {
      const bytes = encoder.encode(value)
      return this.u8(bytes.length).pipe(Effect.andThen(this.raw(bytes)))
    })
  }
  long(value: string | Uint8Array) {
    return Effect.suspend(() => {
      const bytes = typeof value === "string" ? encoder.encode(value) : value
      return this.u32(bytes.length).pipe(Effect.andThen(this.raw(bytes)))
    })
  }
  sized(write: () => Effect.Effect<void, SchemaIssue.Issue>) {
    return this.reserve(4).pipe(
      Effect.flatMap((start) =>
        write().pipe(Effect.tap(() => Effect.sync(() => this.view.setUint32(start, this.length - start - 4))))
      )
    )
  }
  finish() {
    return Effect.sync(() => this.bytes.slice(0, this.length))
  }
}

class DecodeBudget {
  used = 0
  readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  charge(bytes: number): Effect.Effect<void, SchemaIssue.Issue> {
    return Effect.suspend(() => {
      if (bytes > this.limit - this.used) return invalid("Decoded wire value exceeds memory limit")
      this.used += bytes
      return Effect.void
    })
  }
}

class Reader {
  private readonly view: DataView
  readonly bytes: Uint8Array
  readonly budget: DecodeBudget
  offset = 0
  constructor(bytes: Uint8Array, budget = new DecodeBudget(MAX_DECODED_BYTES)) {
    this.bytes = bytes
    this.budget = budget
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  private take(size: number): Effect.Effect<number, SchemaIssue.Issue> {
    return Effect.suspend(() => {
      if (size > this.bytes.length - this.offset) return invalid("Truncated wire value")
      const start = this.offset
      this.offset += size
      return Effect.succeed(start)
    })
  }
  u8() {
    return Effect.map(this.take(1), (offset) => this.view.getUint8(offset))
  }
  u16() {
    return Effect.map(this.take(2), (offset) => this.view.getUint16(offset))
  }
  u32() {
    return Effect.map(this.take(4), (offset) => this.view.getUint32(offset))
  }
  u64() {
    return Effect.map(this.take(8), (offset) => this.view.getBigUint64(offset))
  }
  signed(size: number) {
    return Effect.map(
      this.take(size),
      (offset) =>
        size === 1 ? this.view.getInt8(offset) : size === 2 ? this.view.getInt16(offset) : size === 4 ?
          this.view.getInt32(offset) :
          this.view.getBigInt64(offset)
    )
  }
  float(size: number) {
    return Effect.map(
      this.take(size),
      (offset) => size === 4 ? this.view.getFloat32(offset) : this.view.getFloat64(offset)
    )
  }
  raw(size: number): Effect.Effect<Uint8Array, SchemaIssue.Issue> {
    return Effect.suspend(() =>
      size > MAX_VALUE_BYTES ?
        invalid("Wire value exceeds size limit") :
        Effect.map(this.take(size), (offset) => this.bytes.subarray(offset, offset + size))
    )
  }
  text(bytes: Uint8Array) {
    return this.budget.charge(24 + bytes.length * 2).pipe(Effect.andThen(Effect.try({
      try: () => decoder.decode(bytes),
      catch: () => new SchemaIssue.InvalidValue({ message: "Invalid UTF-8 string" })
    })))
  }
  short() {
    return this.u8().pipe(Effect.flatMap((size) => this.raw(size)), Effect.flatMap((bytes) => this.text(bytes)))
  }
  long() {
    return this.u32().pipe(Effect.flatMap((size) => this.raw(size)))
  }
  done() {
    return Effect.suspend(() => this.offset === this.bytes.length ? Effect.void : invalid("Trailing wire data"))
  }
}

const checkDepth = (depth: number) => depth > MAX_DEPTH ? invalid("Field table nesting exceeds limit") : Effect.void
const writeTable = Effect.fnUntraced(
  function*(writer: Writer, value: AMQPTypes.FieldTable, depth: number): Effect.fn.Return<void, SchemaIssue.Issue> {
    yield* checkDepth(depth)
    yield* writer.sized(() =>
      Effect.gen(function*() {
        for (const [key, field] of Object.entries(value)) {
          yield* writer.short(key)
          yield* writeField(writer, field, depth + 1)
        }
      })
    )
  }
)
const writeField = Effect.fnUntraced(
  function*(writer: Writer, value: AMQPTypes.FieldValue, depth: number): Effect.fn.Return<void, SchemaIssue.Issue> {
    yield* checkDepth(depth)
    const tag = (text: string) => writer.u8(text.charCodeAt(0))
    if (value === null) yield* tag("V")
    else if (typeof value === "boolean") {
      yield* tag("t")
      yield* writer.u8(value ? 1 : 0)
    } else if (typeof value === "string") {
      yield* tag("S")
      yield* writer.long(value)
    } else if (typeof value === "bigint") {
      yield* tag("l")
      yield* writer.signed(value, 8)
    } else if (typeof value === "number") {
      if (Number.isSafeInteger(value)) {
        const size = value >= -128 && value <= 127 ? 1 : value >= -32768 && value <= 32767 ?
          2 :
          value >= -2147483648 && value <= 2147483647
          ? 4
          : 8
        yield* tag(size === 1 ? "b" : size === 2 ? "s" : size === 4 ? "I" : "l")
        yield* writer.signed(value, size)
      } else {
        yield* tag("d")
        yield* writer.float(value)
      }
    } else if (value instanceof Uint8Array) {
      yield* tag("x")
      yield* writer.long(value)
    } else if (typeof value === "object" && AMQPTypes.LongStringTypeId in value) {
      yield* tag("S")
      yield* writer.long((value as AMQPTypes.LongString).bytes)
    } else if (value instanceof Date) {
      yield* tag("T")
      yield* writer.u64(BigInt(Math.floor(value.getTime() / 1000)))
    } else if (Array.isArray(value)) {
      yield* tag("A")
      yield* writer.sized(() =>
        Effect.gen(function*() {
          for (const field of value) yield* writeField(writer, field, depth + 1)
        })
      )
    } else if (typeof value === "object" && AMQPTypes.FieldNumberTypeId in value) {
      const number = value as AMQPTypes.FieldNumber
      yield* tag(number.type === "float" ? "f" : "d")
      yield* writer.float(number.value, number.type === "float" ? 4 : 8)
    } else if (typeof value === "object" && AMQPTypes.DecimalTypeId in value) {
      const decimal = value as AMQPTypes.Decimal
      yield* tag("D")
      yield* writer.u8(decimal.scale)
      yield* writer.u32(decimal.value)
    } else {
      yield* tag("F")
      yield* writeTable(writer, value as AMQPTypes.FieldTable, depth)
    }
  }
)

const readTable = Effect.fnUntraced(
  function*(reader: Reader, depth: number): Effect.fn.Return<AMQPTypes.FieldTable, SchemaIssue.Issue> {
    yield* checkDepth(depth)
    const nested = new Reader(yield* reader.long(), reader.budget)
    // Dictionary storage and array slots are charged before constructing their nodes.
    yield* reader.budget.charge(256)
    const table: Record<string, AMQPTypes.FieldValue> = Object.create(null)
    while (nested.offset < nested.bytes.length) {
      const key = yield* nested.short()
      if (Object.hasOwn(table, key)) return yield* invalid("Duplicate field table key")
      yield* reader.budget.charge(48)
      table[key] = yield* readField(nested, depth + 1)
    }
    return table
  }
)
const readField = Effect.fnUntraced(
  function*(reader: Reader, depth: number): Effect.fn.Return<AMQPTypes.FieldValue, SchemaIssue.Issue> {
    yield* checkDepth(depth)
    yield* reader.budget.charge(32)
    const tag = yield* reader.u8()
    switch (String.fromCharCode(tag)) {
      case "V":
        return null
      case "t": {
        const value = yield* reader.u8()
        if (value > 1) return yield* invalid("Invalid boolean field")
        return value === 1
      }
      case "b":
        return yield* reader.signed(1)
      case "B":
        return yield* reader.u8()
      case "s":
      case "U":
        return yield* reader.signed(2)
      case "u":
        return yield* reader.u16()
      case "I":
        return yield* reader.signed(4)
      case "i":
        return yield* reader.u32()
      case "l":
      case "L":
        return yield* reader.signed(8)
      case "f":
      case "d": {
        const value = yield* reader.float(tag === 102 ? 4 : 8)
        yield* reader.budget.charge(64)
        return AMQPTypes.fieldNumber(tag === 102 ? "float" : "double", value)
      }
      case "D": {
        yield* reader.budget.charge(64)
        return AMQPTypes.decimal(yield* reader.u8(), yield* reader.u32())
      }
      case "S": {
        const bytes = yield* reader.long()
        yield* reader.budget.charge(256 + bytes.length * 2)
        return yield* Effect.try({
          try: () => decoder.decode(bytes),
          catch: () => new SchemaIssue.InvalidValue({ message: "Opaque long string" })
        }).pipe(Effect.catch(() =>
          reader.budget.charge(64).pipe(
            Effect.map(() => AMQPTypes.longString(bytes.slice()))
          )
        ))
      }
      case "x": {
        const bytes = yield* reader.long()
        yield* reader.budget.charge(256 + bytes.length)
        return bytes.slice()
      }
      case "T": {
        const seconds = yield* reader.u64()
        if (seconds > BigInt("8640000000000")) return yield* invalid("Timestamp exceeds Date range")
        yield* reader.budget.charge(64)
        return new Date(Number(seconds) * 1000)
      }
      case "F":
        return yield* readTable(reader, depth)
      case "A": {
        const nested = new Reader(yield* reader.long(), reader.budget)
        yield* reader.budget.charge(64)
        const values: Array<AMQPTypes.FieldValue> = []
        while (nested.offset < nested.bytes.length) values.push(yield* readField(nested, depth + 1))
        return values
      }
      default:
        return yield* invalid(`Unknown field type ${tag}`)
    }
  }
)

/** Binary field-table codec with shared recursive constraints. @since 1.0.0-beta.0 */
export const FieldTableCodec = wireCodec(
  Protocol.fieldTable,
  Effect.fnUntraced(function*(bytes) {
    const reader = new Reader(bytes)
    const table = yield* readTable(reader, 0)
    yield* reader.done()
    return table
  }),
  Effect.fnUntraced(function*(table) {
    const writer = new Writer()
    yield* writeTable(writer, table, 0)
    return yield* writer.finish()
  })
)
/** @since 0.8.0 */
export const encodeFieldTable = boundary(FieldTableCodec).encode

const frameShape = Schema.Struct({
  type: Schema.Literals([1, 2, 3, 8]),
  channel: Protocol.unsigned(65535),
  payload: Schema.Uint8Array.check(Schema.makeFilter((value) => value.length <= MAX_VALUE_BYTES))
}).check(Schema.makeFilter((value) => value.type !== 8 || (value.channel === 0 && value.payload.length === 0)))
/** Complete frame codec; decoded opaque payloads are views of the input bytes. @since 1.0.0-beta.0 */
export const FrameCodec = wireCodec<Frame>(
  frameShape,
  Effect.fnUntraced(function*(bytes) {
    const reader = new Reader(bytes)
    const type = yield* reader.u8()
    const channel = yield* reader.u16()
    const payload = yield* reader.raw(yield* reader.u32())
    if ((yield* reader.u8()) !== 0xce) return yield* invalid("Invalid frame end marker")
    yield* reader.done()
    return { type, channel, payload }
  }),
  Effect.fnUntraced(function*({ type, channel, payload }) {
    const bytes = new Uint8Array(payload.length + 8)
    const view = new DataView(bytes.buffer)
    view.setUint8(0, type)
    view.setUint16(1, channel)
    view.setUint32(3, payload.length)
    bytes.set(payload, 7)
    bytes[bytes.length - 1] = 0xce
    return bytes
  })
)
const frameBoundary = boundary(FrameCodec)
/** @since 0.8.0 */
export const encodeFrame = (type: number, channel: number, payload: Uint8Array) =>
  frameBoundary.encode({ type, channel, payload })

const methodShape = Schema.Union(
  Object.values(Protocol.methods).map((method) =>
    Schema.Struct({
      classId: Schema.Literal(method.classId),
      methodId: Schema.Literal(method.methodId),
      fields: Protocol.fieldsSchema(method)
    })
  )
)
const methodDescriptor = (classId: number, methodId: number) =>
  Protocol.lookup(classId, methodId).pipe(
    Effect.mapError((error) => new SchemaIssue.InvalidValue({ message: error.reason }))
  )
/** Complete, descriptor-derived method payload codec. @since 1.0.0-beta.0 */
export const MethodCodec = wireCodec<Method>(
  methodShape,
  Effect.fnUntraced(function*(bytes) {
    const reader = new Reader(bytes)
    const classId = yield* reader.u16()
    const methodId = yield* reader.u16()
    const descriptor = yield* methodDescriptor(classId, methodId)
    const fields: Record<string, AMQPTypes.FieldValue> = {}
    let bits = 0
    let bitCount = 0
    const finishBits = () => {
      if (bitCount > 0 && (bits >>> bitCount) !== 0) return invalid("Unknown method bit flags")
      bitCount = 0
      return Effect.void
    }
    for (const [name, kind] of descriptor.fields) {
      if (kind === "bit") {
        if (bitCount === 0) bits = yield* reader.u8()
        fields[name] = (bits & (1 << bitCount)) !== 0
        if (++bitCount === 8) bitCount = 0
      } else {
        yield* finishBits()
        if (kind === "bytes") {
          const bytes = yield* reader.long()
          yield* reader.budget.charge(256 + bytes.length)
          fields[name] = bytes.slice()
        } else {
          fields[name] = kind === "short" ? yield* reader.short() : kind === "text" ?
            yield* reader.text(yield* reader.long()) :
            kind === "table" ?
            yield* readTable(reader, 0) :
            yield* reader[kind]()
        }
      }
    }
    yield* finishBits()
    yield* reader.done()
    return { classId, methodId, fields }
  }),
  Effect.fnUntraced(function*({ classId, methodId, fields }) {
    const descriptor = yield* methodDescriptor(classId, methodId)
    const writer = new Writer()
    yield* writer.u16(classId)
    yield* writer.u16(methodId)
    let bits = 0
    let bitCount = 0
    const flush = () => {
      const write = bitCount === 0 ? Effect.void : writer.u8(bits)
      bits = 0
      bitCount = 0
      return write
    }
    for (const [name, kind] of descriptor.fields) {
      const value = fields[name]
      if (kind === "bit") {
        if (value) bits |= 1 << bitCount
        if (++bitCount === 8) yield* flush()
      } else {
        yield* flush()
        if (kind === "short") yield* writer.short(value as string)
        else if (kind === "text" || kind === "bytes") yield* writer.long(value as string | Uint8Array)
        else if (kind === "table") yield* writeTable(writer, value as AMQPTypes.FieldTable, 0)
        else if (kind === "u64") yield* writer.u64(value as bigint)
        else yield* writer[kind](value as number)
      }
    }
    yield* flush()
    return yield* writer.finish()
  })
)
const methodBoundary = boundary(MethodCodec)
/** @since 0.8.0 */
export const decodeMethod = methodBoundary.decode

const inputFieldDecoders = new WeakMap<
  Protocol.MethodDescriptor,
  (input: unknown) => Effect.Effect<Protocol.Fields, Schema.SchemaError>
>()
/** Normalize outgoing defaults, then encode both method and frame through Schema. @since 0.8.0 */
export const encodeMethod: {
  (
    channel: number,
    method: Protocol.MethodDescriptor,
    fields?: Protocol.Fields
  ): Effect.Effect<Uint8Array, AMQPProtocolError>
  (
    channel: number,
    classId: number,
    methodId: number,
    fields?: Protocol.Fields
  ): Effect.Effect<Uint8Array, AMQPProtocolError>
} = Effect.fnUntraced(function*(
  channel: number,
  methodOrClassId: Protocol.MethodDescriptor | number,
  fieldsOrMethodId?: Protocol.Fields | number,
  rawFields: Protocol.Fields = {}
) {
  const method = typeof methodOrClassId === "number" ?
    yield* Protocol.lookup(methodOrClassId, fieldsOrMethodId as number) :
    methodOrClassId
  const fields = typeof methodOrClassId === "number" ? rawFields : (fieldsOrMethodId ?? {}) as Protocol.Fields
  let decode = inputFieldDecoders.get(method)
  if (decode === undefined) {
    decode = Schema.decodeUnknownEffect(Protocol.inputFieldsSchema(method))
    inputFieldDecoders.set(method, decode)
  }
  const normalized = yield* decode(fields).pipe(Effect.mapError(protocolError))
  const payload = yield* methodBoundary.encode({
    classId: method.classId,
    methodId: method.methodId,
    fields: normalized
  })
  return yield* encodeFrame(1, channel, payload)
})

const properties: ReadonlyArray<readonly [keyof AMQPTypes.MessageProperties, Protocol.FieldKind]> = [
  ["contentType", "short"],
  ["contentEncoding", "short"],
  ["headers", "table"],
  ["deliveryMode", "u8"],
  ["priority", "u8"],
  ["correlationId", "short"],
  ["replyTo", "short"],
  ["expiration", "short"],
  ["messageId", "short"],
  ["timestamp", "u64"],
  ["type", "short"],
  ["userId", "short"],
  ["appId", "short"],
  ["clusterId", "short"]
]
const propertyFields = {
  contentType: Schema.optionalKey(Protocol.short),
  contentEncoding: Schema.optionalKey(Protocol.short),
  headers: Schema.optionalKey(Protocol.fieldTable),
  deliveryMode: Schema.optionalKey(Protocol.fieldSchemas.u8),
  priority: Schema.optionalKey(Protocol.fieldSchemas.u8),
  correlationId: Schema.optionalKey(Protocol.short),
  replyTo: Schema.optionalKey(Protocol.short),
  expiration: Schema.optionalKey(Protocol.short),
  messageId: Schema.optionalKey(Protocol.short),
  timestamp: Schema.optionalKey(Protocol.unsigned64),
  type: Schema.optionalKey(Protocol.short),
  userId: Schema.optionalKey(Protocol.short),
  appId: Schema.optionalKey(Protocol.short),
  clusterId: Schema.optionalKey(Protocol.short)
}
const propertiesSchema = Schema.Struct(propertyFields)
const expirationInput = Schema.Union([Protocol.short, Schema.Finite]).pipe(
  Schema.decodeTo(
    Protocol.short,
    SchemaTransformation.transform<string, string | number>({
      decode: String,
      encode: (value) => value
    })
  )
)
const optionalInputProperty = <A, E>(schema: Schema.Codec<A, E>) =>
  Schema.optional(schema).pipe(
    Schema.decodeTo(
      Schema.optionalKey(Schema.toType(schema)),
      SchemaTransformation.transformOptional<A, A | undefined>({
        decode: (value) => Option.filter(value, (value): value is A => value !== undefined),
        encode: (value) => value
      })
    )
  )
const decodeInputProperties = Schema.decodeUnknownEffect(Schema.Struct({
  contentType: optionalInputProperty(Protocol.short),
  contentEncoding: optionalInputProperty(Protocol.short),
  headers: optionalInputProperty(Protocol.fieldTable),
  deliveryMode: optionalInputProperty(Protocol.fieldSchemas.u8),
  priority: optionalInputProperty(Protocol.fieldSchemas.u8),
  correlationId: optionalInputProperty(Protocol.short),
  replyTo: optionalInputProperty(Protocol.short),
  expiration: optionalInputProperty(expirationInput),
  messageId: optionalInputProperty(Protocol.short),
  timestamp: optionalInputProperty(Protocol.unsigned64Input),
  type: optionalInputProperty(Protocol.short),
  userId: optionalInputProperty(Protocol.short),
  appId: optionalInputProperty(Protocol.short),
  clusterId: optionalInputProperty(Protocol.short)
}))

/** Header memory is charged before constructing decoded values. @since 0.8.0 */
export interface ContentHeaderDecodeOptions {
  readonly maxDecodedBytes?: number
}
/** Conservative decoded-property cost for retained-byte admission. @since 0.8.0 */
export interface DecodedContentHeader {
  readonly bodySize: bigint
  readonly properties: AMQPTypes.MessageProperties
  readonly decodedCost: number
}
const contentHeaderShape = Schema.Struct({
  bodySize: Protocol.unsigned64,
  properties: propertiesSchema,
  decodedCost: Protocol.unsigned(Number.MAX_SAFE_INTEGER)
})
const decodeBudgetSize = SchemaParser.decodeUnknownEffect(Protocol.unsigned(Number.MAX_SAFE_INTEGER))
/** Binary content headers with allocation guards inside the transformation. @since 1.0.0-beta.0 */
export const makeContentHeaderCodec = (options: ContentHeaderDecodeOptions = {}) =>
  wireCodec<DecodedContentHeader>(
    contentHeaderShape,
    Effect.fnUntraced(function*(bytes) {
      const limit = yield* decodeBudgetSize(options.maxDecodedBytes ?? MAX_DECODED_BYTES)
      const reader = new Reader(bytes, new DecodeBudget(limit))
      if ((yield* reader.u16()) !== 60) return yield* invalid("Unsupported content class")
      if ((yield* reader.u16()) !== 0) return yield* invalid("Invalid content weight")
      const bodySize = yield* reader.u64()
      const flags = yield* reader.u16()
      if ((flags & 3) !== 0) return yield* invalid("Unknown content property flags")
      yield* reader.budget.charge(64)
      const value: Record<string, AMQPTypes.FieldValue> = {}
      for (const [index, [name, kind]] of properties.entries()) {
        if ((flags & (1 << (15 - index))) === 0) continue
        yield* reader.budget.charge(48)
        value[name] = kind === "short" ? yield* reader.short() : kind === "table" ?
          yield* readTable(reader, 0) :
          kind === "u64"
          ? yield* reader.u64()
          : yield* reader.u8()
      }
      yield* reader.done()
      return { bodySize, properties: value as AMQPTypes.MessageProperties, decodedCost: reader.budget.used }
    }),
    Effect.fnUntraced(function*({ bodySize, properties: value }) {
      const writer = new Writer()
      yield* writer.u16(60)
      yield* writer.u16(0)
      yield* writer.u64(bodySize)
      let flags = 0
      properties.forEach(([name], index) => {
        if (value[name] !== undefined) flags |= 1 << (15 - index)
      })
      yield* writer.u16(flags)
      for (const [name, kind] of properties) {
        const field = value[name]
        if (field === undefined) continue
        if (kind === "short") yield* writer.short(field as string)
        else if (kind === "table") yield* writeTable(writer, field as AMQPTypes.FieldTable, 0)
        else if (kind === "u64") yield* writer.u64(field as bigint)
        else yield* writer.u8(field as number)
      }
      return yield* writer.finish()
    })
  )
/** @since 1.0.0-beta.0 */
export const ContentHeaderCodec = makeContentHeaderCodec()
const contentHeaderBoundary = boundary(ContentHeaderCodec)
/** @since 0.8.0 */
export const encodeContentHeader = Effect.fnUntraced(function*(
  channel: number,
  bodySize: bigint,
  value: AMQPTypes.MessageProperties
) {
  const properties = yield* decodeInputProperties(value).pipe(Effect.mapError(protocolError))
  const payload = yield* contentHeaderBoundary.encode({ bodySize, properties, decodedCost: 0 })
  return yield* encodeFrame(2, channel, payload)
})
/** @since 0.8.0 */
export const decodeContentHeader = (payload: Uint8Array, options: ContentHeaderDecodeOptions = {}) =>
  options.maxDecodedBytes === undefined ?
    contentHeaderBoundary.decode(payload) :
    boundary(makeContentHeaderCodec(options)).decode(payload)

const prefixShape = Schema.Struct({
  type: frameShape.fields.type,
  channel: frameShape.fields.channel,
  payloadLength: Protocol.unsigned(0xffffffff)
}).check(Schema.makeFilter((value) => value.type !== 8 || (value.channel === 0 && value.payloadLength === 0)))
const PrefixCodec = wireCodec<{ readonly type: number; readonly channel: number; readonly payloadLength: number }>(
  prefixShape,
  Effect.fnUntraced(function*(bytes) {
    const reader = new Reader(bytes)
    const prefix = { type: yield* reader.u8(), channel: yield* reader.u16(), payloadLength: yield* reader.u32() }
    yield* reader.done()
    return prefix
  }),
  Effect.fnUntraced(function*(prefix) {
    const writer = new Writer()
    yield* writer.u8(prefix.type)
    yield* writer.u16(prefix.channel)
    yield* writer.u32(prefix.payloadLength)
    return yield* writer.finish()
  })
)
const decodePrefix = SchemaParser.decodeUnknownEffect(PrefixCodec)
const EndMarkerCodec = wireCodec<number>(
  Schema.Literal(0xce),
  Effect.fnUntraced(function*(bytes) {
    const reader = new Reader(bytes)
    const marker = yield* reader.u8()
    if (marker !== 0xce) return yield* invalid("Invalid frame end marker")
    yield* reader.done()
    return marker
  }),
  (marker) => Effect.sync(() => new Uint8Array([marker]))
)
const decodeEndMarker = boundary(EndMarkerCodec).decode
const decodeFrameSize = Schema.decodeUnknownEffect(Protocol.unsigned(0xffffffff))
const decodeChunk = Schema.decodeUnknownEffect(Schema.Uint8Array)
const decodeBufferSize = Schema.decodeUnknownEffect(
  Protocol.unsigned(Number.MAX_SAFE_INTEGER).check(Schema.isGreaterThanOrEqualTo(8))
)

/** Serial frame delivery lets negotiation change limits between coalesced frames. @since 1.0.0-beta.0 */
export interface FrameDecoder {
  readonly maxFrameSize: number
  readonly setMaxFrameSize: (size: number) => Effect.Effect<void, AMQPProtocolError>
  readonly feed: <E, R>(
    chunk: Uint8Array,
    consume: (frame: Frame) => Effect.Effect<boolean, E, R>
  ) => Effect.Effect<void, AMQPProtocolError | E, R>
  readonly end: () => Effect.Effect<void, AMQPProtocolError>
}

/** Copies incoming payload bytes once and allocates only after validating their prefix. @since 1.0.0-beta.0 */
export const makeFrameDecoder = Effect.fnUntraced(
  function*(maxFrameSize = 131072, maxBufferedBytes?: number): Effect.fn.Return<FrameDecoder, AMQPProtocolError> {
    yield* decodeFrameSize(maxFrameSize).pipe(Effect.mapError(protocolError))
    let frameLimit = maxFrameSize === 0 ? MAX_VALUE_BYTES + 8 : maxFrameSize
    const bufferLimit = yield* decodeBufferSize(maxBufferedBytes ?? frameLimit).pipe(Effect.mapError(protocolError))
    const header = new Uint8Array(7)
    let headerLength = 0
    let frame: Frame | undefined
    let payloadLength = 0
    const reserveCodec = wireCodec<Frame>(
      frameShape,
      Effect.fnUntraced(function*(bytes) {
        const prefix = yield* decodePrefix(bytes)
        if (prefix.payloadLength + 8 > frameLimit) return yield* invalid("Frame exceeds negotiated frame maximum")
        if (prefix.payloadLength + 8 > bufferLimit || prefix.payloadLength > MAX_VALUE_BYTES) {
          return yield* invalid("Frame exceeds buffer limit")
        }
        return { type: prefix.type, channel: prefix.channel, payload: new Uint8Array(prefix.payloadLength) }
      }),
      (frame) =>
        SchemaParser.encodeUnknownEffect(PrefixCodec)({
          type: frame.type,
          channel: frame.channel,
          payloadLength: frame.payload.length
        })
    )
    const reserveFrame = boundary(reserveCodec).decode
    const setMaxFrameSize = Effect.fnUntraced(function*(size: number) {
      yield* decodeFrameSize(size).pipe(Effect.mapError(protocolError))
      const limit = size === 0 ? MAX_VALUE_BYTES + 8 : size
      if (frame !== undefined && frame.payload.length + 8 > limit) {
        return yield* new AMQPProtocolError({ reason: "Frame exceeds negotiated frame maximum" })
      }
      frameLimit = limit
    })
    const feed = Effect.fnUntraced(function*<E, R>(
      input: Uint8Array,
      consume: (frame: Frame) => Effect.Effect<boolean, E, R>
    ): Effect.fn.Return<void, AMQPProtocolError | E, R> {
      const chunk = yield* decodeChunk(input).pipe(Effect.mapError(protocolError))
      let offset = 0
      while (offset < chunk.length) {
        if (headerLength < 7) {
          const size = Math.min(7 - headerLength, chunk.length - offset)
          header.set(chunk.subarray(offset, offset + size), headerLength)
          headerLength += size
          offset += size
          if (headerLength < 7) continue
          frame = yield* reserveFrame(header)
        }
        if (frame === undefined) return yield* new AMQPProtocolError({ reason: "Missing frame reservation" })
        const size = Math.min(frame.payload.length - payloadLength, chunk.length - offset)
        frame.payload.set(chunk.subarray(offset, offset + size), payloadLength)
        payloadLength += size
        offset += size
        if (payloadLength < frame.payload.length || offset === chunk.length) continue
        yield* decodeEndMarker(chunk.subarray(offset, offset + 1))
        offset++
        const completed = frame
        headerLength = 0
        payloadLength = 0
        frame = undefined
        if (!(yield* consume(completed))) return
      }
    })
    return {
      get maxFrameSize() {
        return frameLimit
      },
      setMaxFrameSize,
      feed,
      end: () =>
        Effect.suspend(() =>
          headerLength === 0 ?
            Effect.void :
            Effect.fail(new AMQPProtocolError({ reason: "Incomplete frame at end of stream" }))
        )
    }
  }
)
