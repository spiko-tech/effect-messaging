/**
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Api from "./internal/jetstreamApi.ts"
import * as Publish from "./internal/jetstreamPublish.ts"
import * as Wire from "./internal/jetstreamSchemas.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSError from "./NATSError.ts"
import * as NATSHeaders from "./NATSHeaders.ts"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamBatch")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface JetStreamBatch {
  readonly [TypeId]: TypeId
  readonly id: string
  readonly count: number
  readonly add: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<T.BatchMessageOptions | T.BatchMessageOptionsWithReply>
  ) => Effect.Effect<void, NATSError.JetStreamBatchError>
  readonly commit: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<NATSOptions.RequestOptions>
  ) => Effect.Effect<T.BatchAck, NATSError.JetStreamBatchError>
}

/** @internal */
export const make = Effect.fnUntraced(function*(
  api: Api.JetStreamApi,
  subject: string,
  payload?: NATSOptions.Payload,
  options: Partial<T.JetStreamPublishOptions> = {}
): Effect.fn.Return<JetStreamBatch, NATSError.JetStreamBatchError> {
  const id = crypto.randomUUID().replaceAll("-", "")
  const semaphore = yield* Semaphore.make(1)
  let count = 0
  let done = false
  const mapError = Api.mapError(NATSError.JetStreamBatchError)
  const headers = (existing?: NATSHeaders.MsgHdrs, commit = false) => {
    const header = NATSHeaders.mergeNatsHeaders(undefined, existing ?? NATSHeaders.headers())
    header.set("Nats-Batch-Id", id)
    header.set("Nats-Batch-Sequence", String(++count))
    if (commit) header.set("Nats-Batch-Commit", "1")
    return header
  }
  const firstHeaders = yield* Publish.publishHeaders(options).pipe(mapError)
  const first = yield* api.connection.request(subject, payload, {
    timeout: options.timeout ?? api.timeout,
    headers: headers(firstHeaders)
  }).pipe(mapError)
  if (first.data.length > 0) yield* api.decode(first.data, Schema.Struct({})).pipe(mapError)
  return {
    [TypeId]: TypeId,
    id,
    get count() {
      return count
    },
    add: Effect.fnUntraced(
      function*(subject, payload, options = {}) {
        if (done) return yield* new NATSError.JetStreamBatchError({ reason: "Batch publisher is done" })
        const header = headers(yield* Publish.publishHeaders(options).pipe(mapError))
        if ("ack" in options && options.ack) {
          const message = yield* api.connection.request(subject, payload, {
            timeout: options.timeout ?? api.timeout,
            headers: header
          }).pipe(mapError)
          if (message.data.length > 0) yield* api.decode(message.data, Schema.Struct({})).pipe(mapError)
        } else {
          yield* api.connection.publish(subject, payload, { headers: header }).pipe(mapError)
        }
      },
      Effect.tapError(() =>
        Effect.sync(() => {
          done = true
        })
      ),
      Semaphore.withPermit(semaphore)
    ),
    commit: Effect.fnUntraced(function*(subject, payload, options = {}) {
      if (done) return yield* new NATSError.JetStreamBatchError({ reason: "Batch publisher is done" })
      done = true
      const message = yield* api.connection.request(subject, payload, {
        timeout: options.timeout ?? api.timeout,
        headers: headers(options.headers, true)
      }).pipe(mapError)
      const ack = yield* api.decode(message.data, Wire.BatchAck).pipe(mapError)
      if (ack.count !== count) return yield* new NATSError.JetStreamBatchError({ reason: "Batch count mismatch" })
      return ack
    }, Semaphore.withPermit(semaphore))
  }
})
