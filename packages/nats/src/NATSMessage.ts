/**
 * @since 0.1.0
 */
import type { Msg, MsgHdrs } from "nats"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

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
export interface NATSPublishMessage {
  subject: string
  data?: Uint8Array
  options?: {
    headers?: MsgHdrs
    reply?: string
  }
}

/**
 * @category models
 * @since 0.1.0
 */
export interface NATSMessage {
  readonly [TypeId]: TypeId
  readonly msg: Msg
}

/**
 * @category tags
 * @since 0.1.0
 */
export const NATSMessage = Context.GenericTag<NATSMessage>("@effect-messaging/nats/NATSMessage")

/**
 * @category constructors
 * @since 0.1.0
 */
export const make = (msg: Msg): NATSMessage => ({
  [TypeId]: TypeId,
  msg
})

/**
 * @category utils
 * @since 0.1.0
 */
export const data = (message: NATSMessage): Uint8Array => message.msg.data

/**
 * @category utils
 * @since 0.1.0
 */
export const string = (message: NATSMessage): string => message.msg.string()

/**
 * @category utils
 * @since 0.1.0
 */
export const json = <T = unknown>(message: NATSMessage): T => message.msg.json<T>()

/**
 * @category utils
 * @since 0.1.0
 */
export const subject = (message: NATSMessage): string => message.msg.subject

/**
 * @category utils
 * @since 0.1.0
 */
export const headers = (message: NATSMessage): MsgHdrs | undefined => message.msg.headers

/**
 * @category utils
 * @since 0.1.0
 */
export const reply = (message: NATSMessage): string | undefined => message.msg.reply

/**
 * @since 0.1.0
 * @category Layers
 */
export const layer = (message: NATSMessage): Layer.Layer<NATSMessage> =>
  Layer.succeed(NATSMessage, message)