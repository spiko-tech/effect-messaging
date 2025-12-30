/**
 * @since 0.7.0
 */
import * as internal from "./internal/JetStreamSubscriberResponse.js"

/**
 * @category type ids
 * @since 0.7.0
 */
export const TypeId: unique symbol = internal.TypeId

/**
 * @category type ids
 * @since 0.7.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.7.0
 */
export interface Ack {
  readonly [TypeId]: TypeId
  readonly _tag: "Ack"
}

/**
 * @category models
 * @since 0.7.0
 */
export interface NakOptions {
  readonly millis?: number
}

/**
 * @category models
 * @since 0.7.0
 */
export interface Nak {
  readonly [TypeId]: TypeId
  readonly _tag: "Nak"
  readonly millis?: number | undefined
}

/**
 * @category models
 * @since 0.7.0
 */
export interface TermOptions {
  readonly reason?: string
}

/**
 * @category models
 * @since 0.7.0
 */
export interface Term {
  readonly [TypeId]: TypeId
  readonly _tag: "Term"
  readonly reason?: string | undefined
}

/**
 * @category models
 * @since 0.7.0
 */
export type JetStreamSubscriberResponse = Ack | Nak | Term

/**
 * @category constructors
 * @since 0.7.0
 */
export const ack: () => JetStreamSubscriberResponse = internal.ack

/**
 * @category constructors
 * @since 0.7.0
 */
export const nak: (options?: NakOptions) => JetStreamSubscriberResponse = internal.nak

/**
 * @category constructors
 * @since 0.7.0
 */
export const term: (options?: TermOptions) => JetStreamSubscriberResponse = internal.term

/**
 * @category guards
 * @since 0.7.0
 */
export const isJetStreamSubscriberResponse: (u: unknown) => u is JetStreamSubscriberResponse =
  internal.isJetStreamSubscriberResponse
