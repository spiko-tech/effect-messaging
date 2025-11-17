/**
 * @since 0.1.0
 */
import type * as NATSCore from "@nats-io/nats-core"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/NATSMessage")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSMessage {
  readonly [TypeId]: TypeId
  readonly subject: string
  readonly sid: number
  readonly reply: Option.Option<string>
  readonly data: Uint8Array
  readonly headers: Option.Option<NATSCore.MsgHdrs>
  readonly respond: (
    ...params: Parameters<NATSCore.Msg["respond"]>
  ) => Effect.Effect<boolean, NATSError.NATSMessageError>
  readonly json: <T>(...params: Parameters<NATSCore.Msg["json"]>) => Effect.Effect<T, NATSError.NATSMessageError>
  readonly string: () => Effect.Effect<string, NATSError.NATSMessageError>

  /** @internal */
  readonly msg: NATSCore.Msg
}

/** @internal */
const wrap = <A>(fn: () => A, errorReason: string): Effect.Effect<A, NATSError.NATSMessageError> =>
  Effect.try({ try: fn, catch: (error) => new NATSError.NATSMessageError({ reason: errorReason, cause: error }) })

/** @internal */
export const make = (msg: NATSCore.Msg): NATSMessage => ({
  [TypeId]: TypeId,
  subject: msg.subject,
  sid: msg.sid,
  reply: Option.fromNullable(msg.reply),
  data: msg.data,
  headers: Option.fromNullable(msg.headers),
  respond: (...params: Parameters<NATSCore.Msg["respond"]>) =>
    wrap(() => msg.respond(...params), "Failed to respond to NATS message"),
  json: (...params: Parameters<NATSCore.Msg["json"]>) =>
    wrap(() => msg.json(...params), "Failed to parse NATS message as JSON"),
  string: () => wrap(() => msg.string(), "Failed to convert NATS message to string"),
  msg
})
