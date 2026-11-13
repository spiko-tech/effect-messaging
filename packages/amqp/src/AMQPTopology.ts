/**
 * References whose identity survives physical connection recovery.
 * @since 0.8.0
 */
import type * as AMQPTypes from "./AMQPTypes.ts"

/**
 * Identifies recovery-aware queue references without reserving a queue name.
 * @since 0.8.0
 * @category symbols
 */
export const QueueTypeId: unique symbol = Symbol.for("@effect-messaging/amqp/QueueReference")

/**
 * The name is the current physical name. Pass the reference itself to bindings
 * and consumers to follow server-generated names across recovery. The reference
 * remains valid for the connection's lifetime, even if the declaring channel closes
 * while another channel's consumer or binding depends on it.
 * @since 0.8.0
 * @category models
 */
export interface QueueReference extends AMQPTypes.QueueReply {
  readonly [QueueTypeId]: typeof QueueTypeId
}

/**
 * A literal broker name or a reference that follows declaration recovery.
 * @since 0.8.0
 * @category models
 */
export type QueueName = string | QueueReference
