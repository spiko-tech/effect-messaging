/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import type * as NATSCore from "@nats-io/nats-core"
import type * as Effect from "effect/Effect"
import * as utils from "./internal/utils.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamStoredMessage")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Stored Message
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamStoredMessage {
  readonly [TypeId]: TypeId
  readonly subject: string
  readonly seq: number
  readonly header: NATSCore.MsgHdrs
  readonly data: Uint8Array
  readonly time: Date
  readonly timestamp: string
  readonly lastSequence: number
  readonly pending: number
  readonly json: <T>(
    ...params: Parameters<JetStream.StoredMsg["json"]>
  ) => Effect.Effect<T, NATSError.JetStreamStoredMessageError>
  readonly string: Effect.Effect<string, NATSError.JetStreamStoredMessageError>

  /** @internal */
  readonly msg: JetStream.StoredMsg
}

const wrap = utils.wrap(NATSError.JetStreamStoredMessageError)

/**
 * @since 0.1.0
 * @category constructors
 */
export const make = (msg: JetStream.StoredMsg): JetStreamStoredMessage => ({
  [TypeId]: TypeId,
  subject: msg.subject,
  seq: msg.seq,
  header: msg.header,
  data: msg.data,
  time: msg.time,
  timestamp: msg.timestamp,
  lastSequence: msg.lastSequence,
  pending: msg.pending,
  json: (...params: Parameters<JetStream.StoredMsg["json"]>) =>
    wrap(() => msg.json(...params), "Failed to parse JetStream stored message as JSON"),
  string: wrap(() => msg.string(), "Failed to convert JetStream stored message to string"),
  msg
})
