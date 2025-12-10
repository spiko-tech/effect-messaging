/**
 * @since 0.1.0
 */
import type * as JetStream from "@nats-io/jetstream"
import type * as Effect from "effect/Effect"
import * as utils from "./internal/utils.js"
import * as NATSError from "./NATSError.js"

/**
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamBatch")

/**
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a NATS JetStream Batch
 *
 * @category models
 * @since 0.1.0
 */
export interface JetStreamBatch {
  readonly [TypeId]: TypeId
  readonly id: string
  readonly count: number
  readonly add: (
    subj: string,
    payload?: Uint8Array | string,
    opts?: Partial<JetStream.BatchMessageOptions | JetStream.BatchMessageOptionsWithReply>
  ) => Effect.Effect<void, NATSError.JetStreamBatchError>
  readonly commit: (
    ...params: Parameters<JetStream.Batch["commit"]>
  ) => Effect.Effect<JetStream.BatchAck, NATSError.JetStreamBatchError>

  /** @internal */
  readonly batch: JetStream.Batch
}

const wrapAsync = utils.wrapAsync(NATSError.JetStreamBatchError)

/** @internal */
export const make = (batch: JetStream.Batch): JetStreamBatch => ({
  [TypeId]: TypeId,
  id: batch.id,
  count: batch.count,
  add: (
    subj: string,
    payload?: Uint8Array | string,
    opts?: Partial<JetStream.BatchMessageOptions | JetStream.BatchMessageOptionsWithReply>
  ) => wrapAsync(async () => batch.add(subj, payload, opts as any), "Failed to add message to batch"),
  commit: (...params: Parameters<JetStream.Batch["commit"]>) =>
    wrapAsync(() => batch.commit(...params), "Failed to commit batch"),

  batch
})
