/**
 * @since 0.7.0
 */

/**
 * @category type ids
 * @since 0.7.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamSubscriberResponse")

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

class AckImpl implements Ack {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Ack" as const
}

class NakImpl implements Nak {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Nak" as const

  constructor(readonly millis?: number) {}
}

class TermImpl implements Term {
  readonly [TypeId]: TypeId = TypeId
  readonly _tag = "Term" as const

  constructor(readonly reason?: string) {}
}

/**
 * @category constructors
 * @since 0.7.0
 */
export const ack = (): JetStreamSubscriberResponse => new AckImpl()

/**
 * @category constructors
 * @since 0.7.0
 */
export const nak = (options?: NakOptions): JetStreamSubscriberResponse => new NakImpl(options?.millis)

/**
 * @category constructors
 * @since 0.7.0
 */
export const term = (options?: TermOptions): JetStreamSubscriberResponse => new TermImpl(options?.reason)

/**
 * @category guards
 * @since 0.7.0
 */
export const isJetStreamSubscriberResponse = (u: unknown): u is JetStreamSubscriberResponse =>
  typeof u === "object" && u !== null && TypeId in u
