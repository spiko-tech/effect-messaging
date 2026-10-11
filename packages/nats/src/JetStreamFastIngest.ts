/**
 * @since 1.0.0
 */
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as Api from "./internal/jetstreamApi.ts"
import * as Publish from "./internal/jetstreamPublish.ts"
import * as Wire from "./internal/jetstreamSchemas.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSError from "./NATSError.ts"
import type * as NATSOptions from "./NATSOptions.ts"

/** @since 1.0.0 */
export interface FastIngestOptions {
  readonly allowGaps: boolean
  readonly ackInterval?: number
  readonly inboxPrefix?: string
  readonly maxOutstandingAcks?: number
}
/** @since 1.0.0 */
export interface FastIngestProgress {
  readonly batchSeq: number
  readonly ackSeq: number
}
/** @since 1.0.0 */
export interface FastIngest {
  readonly batch: string
  readonly gaps: Stream.Stream<{ readonly lastSeq: number; readonly seq: number }, NATSError.JetStreamBatchError>
  readonly add: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<FastIngestProgress, NATSError.JetStreamBatchError>
  readonly last: (
    subject: string,
    payload?: NATSOptions.Payload,
    options?: Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<T.BatchAck, NATSError.JetStreamBatchError>
  readonly end: (
    options?: Partial<T.JetStreamPublishOptions>
  ) => Effect.Effect<T.BatchAck, NATSError.JetStreamBatchError>
  readonly ping: (timeout?: number) => Effect.Effect<FastIngestProgress, NATSError.JetStreamBatchError>
  readonly done: Effect.Effect<T.BatchAck, NATSError.JetStreamBatchError>
}
const FlowResponse = Schema.Union([
  Wire.BatchAck,
  Schema.Struct({ type: Schema.Literal("ack"), seq: Schema.Number, msgs: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("gap"), last_seq: Schema.Number, seq: Schema.Number })
])
interface FlowState {
  readonly acked: number
  readonly interval: number
  readonly closed: boolean
  readonly error: Option.Option<NATSError.JetStreamBatchError>
}

/** @internal */
export const make = Effect.fn("JetStreamFastIngest.make")(function*(
  api: Api.JetStreamApi,
  subject: string,
  payload: NATSOptions.Payload | undefined,
  options: FastIngestOptions & Partial<T.JetStreamPublishOptions>
): Effect.fn.Return<FastIngest, NATSError.JetStreamBatchError, Scope.Scope> {
  const mapError = Api.mapError(NATSError.JetStreamBatchError)
  yield* api.requireVersion("Fast ingest", [2, 14, 0]).pipe(mapError)
  const prefix = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[^\s*>]+$/)))(
    options.inboxPrefix ?? (yield* api.connection.createInbox)
  ).pipe(mapError)
  const interval = yield* Schema.decodeUnknownEffect(Schema.Number.check(Schema.isGreaterThan(0), Schema.isInt()))(
    options.ackInterval ?? 10
  ).pipe(mapError)
  const windows = Math.max(1, Math.min(3, options.maxOutstandingAcks ?? 2))
  const id = crypto.randomUUID().replaceAll("-", "")
  const gapMode = options.allowGaps ? "ok" : "fail"
  const flow = yield* SubscriptionRef.make<FlowState>({ acked: 0, interval, closed: false, error: Option.none() })
  const started = yield* Deferred.make<void, NATSError.JetStreamBatchError>()
  const done = yield* Deferred.make<T.BatchAck, NATSError.JetStreamBatchError>()
  const gaps = yield* Queue.make<
    { readonly lastSeq: number; readonly seq: number },
    NATSError.JetStreamBatchError | Cause.Done
  >({ capacity: 128, strategy: "sliding" })
  const pings = new Map<string, Deferred.Deferred<FastIngestProgress, NATSError.JetStreamBatchError>>()
  let sequence = 1
  let ending = false
  const replyFor = (seq: number, operation: number) => `${prefix}.${id}.${interval}.${gapMode}.${seq}.${operation}.$FI`
  const subscription = yield* api.connection.subscribe(`${prefix}.${id}.>`).pipe(mapError)
  const fail = Effect.fnUntraced(function*(error: NATSError.JetStreamBatchError) {
    yield* SubscriptionRef.update(flow, (state) => ({ ...state, closed: true, error: Option.some(error) }))
    yield* Deferred.fail(started, error)
    yield* Deferred.fail(done, error)
    for (const waiter of pings.values()) yield* Deferred.fail(waiter, error)
    pings.clear()
    yield* Queue.fail(gaps, error)
    yield* subscription.unsubscribe().pipe(Effect.ignore)
  })
  yield* Effect.addFinalizer(() => fail(new NATSError.JetStreamBatchError({ reason: "Fast ingest scope closed" })))
  yield* subscription.stream.pipe(
    Stream.runForEach(Effect.fnUntraced(function*(message) {
      const response = yield* api.decode(message.data, FlowResponse).pipe(mapError)
      if ("batch" in response) {
        yield* Deferred.succeed(done, response)
        yield* Deferred.succeed(started, undefined)
        const state = yield* SubscriptionRef.get(flow)
        yield* SubscriptionRef.set(flow, { ...state, closed: true })
        for (const waiter of pings.values()) {
          yield* Deferred.succeed(waiter, {
            batchSeq: sequence,
            ackSeq: state.acked
          })
        }
        pings.clear()
        yield* Queue.end(gaps)
        yield* subscription.unsubscribe().pipe(mapError)
      } else if (response.type === "gap") {
        yield* Queue.offer(gaps, { lastSeq: response.last_seq, seq: response.seq })
      } else {
        const state = yield* SubscriptionRef.updateAndGet(flow, (state) => ({
          ...state,
          acked: Math.max(state.acked, response.seq),
          interval: response.msgs > 0 ? response.msgs : state.interval
        }))
        yield* Deferred.succeed(started, undefined)
        const waiter = pings.get(message.subject)
        if (waiter) {
          pings.delete(message.subject)
          yield* Deferred.succeed(waiter, { batchSeq: sequence, ackSeq: state.acked })
        }
      }
    })),
    mapError,
    Effect.catch(fail),
    Effect.forkScoped
  )
  const deadline = <A>(effect: Effect.Effect<A, NATSError.JetStreamBatchError>, timeout: number) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new NATSError.JetStreamBatchError({ reason: "Fast ingest acknowledgement timed out" }))
      }),
      Effect.tapError(fail)
    )
  const firstHeaders = yield* Publish.publishHeaders(options).pipe(mapError)
  yield* api.connection.publish(subject, payload, { reply: replyFor(1, 0), headers: firstHeaders }).pipe(mapError)
  yield* deadline(Deferred.await(started), options.timeout ?? api.timeout)
  const terminal = Effect.fnUntraced(function*(
    subject: string,
    payload: NATSOptions.Payload | undefined,
    options: Partial<T.JetStreamPublishOptions>,
    operation: number
  ) {
    if (ending || (yield* SubscriptionRef.get(flow)).closed) {
      return yield* new NATSError.JetStreamBatchError({ reason: "Fast ingest batch is closed" })
    }
    ending = true
    const seq = ++sequence
    const headers = yield* Publish.publishHeaders(options).pipe(mapError)
    yield* api.connection.publish(subject, payload, { reply: replyFor(seq, operation), headers }).pipe(mapError)
    return yield* deadline(Deferred.await(done), options.timeout ?? api.timeout)
  })
  return {
    batch: id,
    gaps: Stream.fromQueue(gaps),
    done: Deferred.await(done),
    add: Effect.fnUntraced(function*(subject, payload, options = {}) {
      if (ending || (yield* SubscriptionRef.get(flow)).closed) {
        return yield* new NATSError.JetStreamBatchError({ reason: "Fast ingest batch is closed" })
      }
      const seq = ++sequence
      const headers = yield* Publish.publishHeaders(options).pipe(mapError)
      yield* api.connection.publish(subject, payload, { reply: replyFor(seq, 1), headers }).pipe(mapError)
      const state = yield* deadline(
        SubscriptionRef.changes(flow).pipe(
          Stream.filter((state) => state.closed || seq - state.acked < state.interval * windows),
          Stream.runHead,
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new NATSError.JetStreamBatchError({ reason: "Fast ingest batch closed" })),
            onSome: Effect.succeed
          }))
        ),
        options.timeout ?? api.timeout
      )
      if (Option.isSome(state.error)) return yield* state.error.value
      return { batchSeq: seq, ackSeq: state.acked }
    }),
    last: (subject, payload, options = {}) => terminal(subject, payload, options, 2),
    end: (options = {}) => terminal(subject, undefined, options, 3),
    ping: Effect.fnUntraced(function*(timeout = api.timeout) {
      const state = yield* SubscriptionRef.get(flow)
      if (state.closed) return yield* new NATSError.JetStreamBatchError({ reason: "Fast ingest batch is closed" })
      const reply = replyFor(sequence, 4)
      const existing = pings.get(reply)
      if (existing) return yield* deadline(Deferred.await(existing), timeout)
      const waiter = yield* Deferred.make<FastIngestProgress, NATSError.JetStreamBatchError>()
      pings.set(reply, waiter)
      yield* api.connection.publish(subject, undefined, { reply }).pipe(mapError)
      return yield* deadline(Deferred.await(waiter), timeout).pipe(
        Effect.ensuring(Effect.sync(() => pings.delete(reply)))
      )
    })
  }
})
