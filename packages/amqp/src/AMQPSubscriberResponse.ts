/**
 * @since 0.4.0
 */
import * as internal from "./internal/AMQPSubscriberResponse.js"

/**
 * @category type ids
 * @since 0.4.0
 */
export const TypeId: unique symbol = internal.TypeId

/**
 * @category type ids
 * @since 0.4.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.4.0
 */
export interface Ack {
  readonly [TypeId]: TypeId
  readonly _tag: "Ack"
}

/**
 * @category models
 * @since 0.4.0
 */
export interface NackOptions {
  readonly allUpTo?: boolean
  readonly requeue?: boolean
}

/**
 * @category models
 * @since 0.4.0
 */
export interface Nack {
  readonly [TypeId]: TypeId
  readonly _tag: "Nack"
  readonly allUpTo?: boolean | undefined
  readonly requeue?: boolean | undefined
}

/**
 * @category models
 * @since 0.4.0
 */
export interface RejectOptions {
  readonly requeue?: boolean
}

/**
 * @category models
 * @since 0.4.0
 */
export interface Reject {
  readonly [TypeId]: TypeId
  readonly _tag: "Reject"
  readonly requeue?: boolean | undefined
}

/**
 * @category models
 * @since 0.4.0
 */
export type AMQPSubscriberResponse = Ack | Nack | Reject

/**
 * @category constructors
 * @since 0.4.0
 */
export const ack: () => AMQPSubscriberResponse = internal.ack

/**
 * @category constructors
 * @since 0.4.0
 */
export const nack: (options?: NackOptions) => AMQPSubscriberResponse = internal.nack

/**
 * @category constructors
 * @since 0.4.0
 */
export const reject: (options?: RejectOptions) => AMQPSubscriberResponse = internal.reject

/**
 * @category guards
 * @since 0.4.0
 */
export const isAMQPSubscriberResponse: (u: unknown) => u is AMQPSubscriberResponse = internal.isAMQPSubscriberResponse
