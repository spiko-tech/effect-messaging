/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import type * as NATSCore from "@nats-io/nats-core"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { wrap, wrapAsync } from "./internal/utils.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamMessage")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a JetStream message
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamMessage {
  readonly [TypeId]: TypeId
  readonly redelivered: boolean
  readonly info: JetStream.DeliveryInfo
  readonly seq: number
  readonly headers: Option.Option<NATSCore.MsgHdrs>
  readonly data: Uint8Array
  readonly subject: string
  readonly sid: number
  readonly time: Date
  readonly timestamp: string
  readonly timestampNanos: bigint
  readonly ack: Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly nak: (
    ...params: Parameters<JetStream.JsMsg["nak"]>
  ) => Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly working: Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly term: (
    ...params: Parameters<JetStream.JsMsg["term"]>
  ) => Effect.Effect<void, NATSError.JetStreamMessageError>
  readonly ackAck: (
    ...params: Parameters<JetStream.JsMsg["ackAck"]>
  ) => Effect.Effect<boolean, NATSError.JetStreamMessageError>
  readonly json: <T = unknown>() => Effect.Effect<T, NATSError.JetStreamMessageError>
  readonly string: () => string

  /** @internal */
  readonly jsMsg: JetStream.JsMsg
}

const wrapSync = wrap(NATSError.JetStreamMessageError)
const wrapPromise = wrapAsync(NATSError.JetStreamMessageError)

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (jsMsg: JetStream.JsMsg): JetStreamMessage => ({
  [TypeId]: TypeId,
  redelivered: jsMsg.redelivered,
  info: jsMsg.info,
  seq: jsMsg.seq,
  headers: Option.fromNullable(jsMsg.headers),
  data: jsMsg.data,
  subject: jsMsg.subject,
  sid: jsMsg.sid,
  time: jsMsg.time,
  timestamp: jsMsg.timestamp,
  timestampNanos: jsMsg.timestampNanos,
  ack: wrapSync(() => jsMsg.ack(), "Failed to acknowledge message"),
  nak: (...params) => wrapSync(() => jsMsg.nak(...params), "Failed to negative acknowledge message"),
  working: wrapSync(() => jsMsg.working(), "Failed to send working status"),
  term: (...params) => wrapSync(() => jsMsg.term(...params), "Failed to terminate message"),
  ackAck: (...params) => wrapPromise(() => jsMsg.ackAck(...params), "Failed to acknowledge message with ack"),
  json: <T = unknown>() => wrapSync(() => jsMsg.json<T>(), "Failed to parse JSON"),
  string: () => jsMsg.string(),
  jsMsg
})
