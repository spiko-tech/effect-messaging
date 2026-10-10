/**
 * References whose identity survives physical connection recovery.
 * @since 0.8.0
 */
import type * as AMQPTypes from "./AMQPTypes.ts"

/** @since 0.8.0 */
export const QueueTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/QueueReference")

/**
 * The name is the current physical name. Pass the reference itself to bindings
 * and consumers to follow server-generated names across recovery.
 * @since 0.8.0
 */
export interface QueueReference extends AMQPTypes.QueueReply {
  readonly [QueueTypeId]: typeof QueueTypeId
}

/** @since 0.8.0 */
export type QueueName = string | QueueReference
