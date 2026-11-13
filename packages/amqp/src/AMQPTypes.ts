/**
 * Native AMQP 0-9-1 data types. Payloads and field tables are runtime independent.
 * @since 0.8.0
 */

/**
 * Non-wire discriminator for decimal scalars.
 * @since 0.8.0
 */
export const DecimalTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/Decimal")

/**
 * Decimal mantissas are signed 32-bit; legacy unsigned input bit patterns are also accepted.
 * Use decimal to construct scalars; plain {_tag, scale, value} objects are ordinary field tables.
 * @since 0.8.0
 */
export interface Decimal {
  readonly [DecimalTypeId]: typeof DecimalTypeId
  readonly _tag: "Decimal"
  readonly scale: number
  readonly value: number
}

/**
 * Construct a decimal scalar without reserving field-table keys.
 * @since 0.8.0
 */
export const decimal = (scale: number, value: number): Decimal => ({
  [DecimalTypeId]: DecimalTypeId,
  _tag: "Decimal",
  scale,
  value
})

/**
 * Non-wire discriminator for explicitly typed floating-point header values.
 * @since 0.8.0
 */
export const FieldNumberTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/FieldNumber")

/**
 * Preserves the floating-point wire type, including when the value is integral.
 * @since 0.8.0
 */
export interface FieldNumber {
  readonly [FieldNumberTypeId]: typeof FieldNumberTypeId
  readonly type: "float" | "double"
  readonly value: number
}

/**
 * Request an AMQP float or double rather than the automatic integer encoding.
 * @since 0.8.0
 */
export const fieldNumber = (type: FieldNumber["type"], value: number): FieldNumber => ({
  [FieldNumberTypeId]: FieldNumberTypeId,
  type,
  value
})

/** @since 1.0.0-beta.0 */
export const FieldIntegerTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/FieldInteger")
/**
 * Preserves an explicitly selected signed or unsigned integer wire width.
 * @since 1.0.0-beta.0
 * @category models
 */
export interface FieldInteger {
  readonly [FieldIntegerTypeId]: typeof FieldIntegerTypeId
  readonly type: "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "int64"
  readonly value: number | bigint
}
/**
 * Values are checked against their selected width when encoded.
 * @since 1.0.0-beta.0
 * @category constructors
 */
export const fieldInteger = (type: FieldInteger["type"], value: number | bigint): FieldInteger => ({
  [FieldIntegerTypeId]: FieldIntegerTypeId,
  type,
  value
})
/** @since 1.0.0-beta.0 */
export const FieldTimestampTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/FieldTimestamp")
/**
 * Full unsigned 64-bit timestamp in seconds, independent of JavaScript Date's range.
 * @since 1.0.0-beta.0
 * @category models
 */
export interface FieldTimestamp {
  readonly [FieldTimestampTypeId]: typeof FieldTimestampTypeId
  readonly seconds: bigint
}
/** @since 1.0.0-beta.0 */
export const fieldTimestamp = (seconds: bigint): FieldTimestamp => ({
  [FieldTimestampTypeId]: FieldTimestampTypeId,
  seconds
})

/**
 * Non-wire discriminator for opaque AMQP long-string scalars.
 * @since 1.0.0-beta.0
 */
export const LongStringTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/LongString")

/**
 * Preserves the long-string (S) wire type for bytes that are not valid UTF-8.
 * @since 1.0.0-beta.0
 */
export interface LongString {
  readonly [LongStringTypeId]: typeof LongStringTypeId
  readonly bytes: Uint8Array
}

/**
 * Request an AMQP long-string (S); an unwrapped Uint8Array uses the byte-array (x) wire type.
 * @since 1.0.0-beta.0
 */
export const longString = (bytes: Uint8Array): LongString => ({
  [LongStringTypeId]: LongStringTypeId,
  bytes
})

/**
 * Table bigints are signed 64-bit values; non-UTF-8 long strings decode as LongString scalars.
 * @since 0.8.0
 */
export type FieldValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | Date
  | Decimal
  | FieldNumber
  | FieldInteger
  | FieldTimestamp
  | LongString
  | ReadonlyArray<FieldValue>
  | FieldTable

/** @since 0.8.0 */
export interface FieldTable {
  readonly [key: string]: FieldValue
}

/** @since 0.8.0 */
export interface MessageProperties {
  readonly contentType?: string
  readonly contentEncoding?: string
  readonly headers?: FieldTable
  readonly deliveryMode?: number
  readonly priority?: number
  readonly correlationId?: string
  readonly replyTo?: string
  readonly expiration?: string | number
  readonly messageId?: string
  readonly timestamp?: bigint | number
  readonly type?: string
  readonly userId?: string
  readonly appId?: string
  readonly clusterId?: string
}

/** @since 0.8.0 */
export interface PublishOptions extends Omit<MessageProperties, "deliveryMode"> {
  /** Legacy boolean values map to persistent (true) or transient (false). @since 1.0.0-beta.0 */
  readonly deliveryMode?: number | boolean
  readonly mandatory?: boolean
  readonly persistent?: boolean
  readonly CC?: string | ReadonlyArray<string>
  readonly BCC?: string | ReadonlyArray<string>
}

/** @since 0.8.0 */
export interface QueueOptions {
  readonly durable?: boolean
  readonly exclusive?: boolean
  readonly autoDelete?: boolean
  readonly arguments?: FieldTable
  readonly messageTtl?: number
  readonly expires?: number
  readonly deadLetterExchange?: string
  readonly deadLetterRoutingKey?: string
  readonly maxLength?: number
  readonly maxLengthBytes?: number
  readonly maxPriority?: number
  readonly overflow?: string
  readonly singleActiveConsumer?: boolean
  readonly queueMode?: string
  readonly queueType?: string
  readonly consumerTimeout?: number
}

/** @since 0.8.0 */
export interface ExchangeOptions {
  readonly durable?: boolean
  readonly autoDelete?: boolean
  readonly internal?: boolean
  readonly arguments?: FieldTable
  readonly alternateExchange?: string
}

/** @since 0.8.0 */
export interface ConsumeOptions {
  readonly prefetch?: number
  readonly noAck?: boolean
  readonly noLocal?: boolean
  readonly maxBufferedMessages?: number
  readonly priority?: number
  readonly exclusive?: boolean
  readonly consumerTag?: string
  readonly arguments?: FieldTable
}

/** @since 1.0.0-beta.0 */
export interface GetOptions {
  readonly noAck?: boolean
}

/** @since 0.8.0 */
export interface QueueReply {
  readonly queue: string
  readonly messageCount: number
  readonly consumerCount: number
}

/** @since 0.8.0 */
export interface ReturnedMessage {
  readonly content: Uint8Array
  readonly properties: MessageProperties
  readonly fields: {
    readonly replyCode: number
    readonly replyText: string
    readonly exchange: string
    readonly routingKey: string
  }
}
