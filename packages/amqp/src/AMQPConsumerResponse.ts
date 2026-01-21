/**
 * @since 0.5.0
 */

/**
 * @category type ids
 * @since 0.5.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/amqp/AMQPConsumerResponse")

/**
 * @category type ids
 * @since 0.5.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 0.5.0
 */
export interface Ack {
  readonly [TypeId]: TypeId
  readonly _tag: "Ack"
}

/**
 * @category models
 * @since 0.5.0
 */
export interface NackOptions {
  readonly allUpTo?: boolean
  readonly requeue?: boolean
}

/**
 * @category models
 * @since 0.5.0
 */
export interface Nack {
  readonly [TypeId]: TypeId
  readonly _tag: "Nack"
  readonly allUpTo?: boolean | undefined
  readonly requeue?: boolean | undefined
}

/**
 * @category models
 * @since 0.5.0
 */
export interface RejectOptions {
  readonly requeue?: boolean
}

/**
 * @category models
 * @since 0.5.0
 */
export interface Reject {
  readonly [TypeId]: TypeId
  readonly _tag: "Reject"
  readonly requeue?: boolean | undefined
}

/**
 * @category models
 * @since 0.5.0
 */
export type AMQPConsumerResponse = Ack | Nack | Reject

class AckImpl implements Ack {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Ack" as const
}

class NackImpl implements Nack {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Nack" as const

  constructor(
    readonly allUpTo?: boolean,
    readonly requeue?: boolean
  ) {}
}

class RejectImpl implements Reject {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Reject" as const

  constructor(readonly requeue?: boolean) {}
}

/**
 * @category constructors
 * @since 0.5.0
 */
export const ack = (): AMQPConsumerResponse => new AckImpl()

/**
 * @category constructors
 * @since 0.5.0
 */
export const nack = (options?: NackOptions): AMQPConsumerResponse => new NackImpl(options?.allUpTo, options?.requeue)

/**
 * @category constructors
 * @since 0.5.0
 */
export const reject = (options?: RejectOptions): AMQPConsumerResponse => new RejectImpl(options?.requeue)

/**
 * @category guards
 * @since 0.5.0
 */
export const isAMQPConsumerResponse = (u: unknown): u is AMQPConsumerResponse =>
  typeof u === "object" && u !== null && TypeId in u
