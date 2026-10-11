/**
 * @since 1.0.0
 */
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as JetStreamDirectStreamAPI from "./JetStreamDirectStreamAPI.ts"
import type * as JetStreamStoredMessage from "./JetStreamStoredMessage.ts"
import type * as T from "./JetStreamTypes.ts"
import type * as NATSError from "./NATSError.ts"
import * as NATSQueuedIterator from "./NATSQueuedIterator.ts"

/** @since 1.0.0 */
export type DirectStartOptions = { readonly seq?: number } | { readonly start_time: string | Date }
/** @since 1.0.0 */
export type DirectBatchLimits = { readonly batch?: number; readonly max_bytes?: number; readonly next_by_subj?: string }
/** @since 1.0.0 */
export interface DirectConsumer {
  readonly stream: string
  readonly status: Stream.Stream<T.ConsumerNotification>
  readonly fetch: (options?: DirectBatchLimits) => Effect.Effect<
    JetStreamDirectStreamAPI.DirectMessages,
    NATSError.JetStreamDirectStreamAPIError,
    Scope.Scope
  >
  readonly consume: (options?: DirectBatchLimits) => Effect.Effect<
    JetStreamDirectStreamAPI.DirectMessages,
    NATSError.JetStreamDirectStreamAPIError,
    Scope.Scope
  >
  readonly next: Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamDirectStreamAPIError
  >
}

/** @since 1.0.0 */
export const make = Effect.fn("JetStreamDirectConsumer.make")(function*(
  api: JetStreamDirectStreamAPI.JetStreamDirectStreamAPI,
  stream: string,
  start: DirectStartOptions = { seq: 1 }
): Effect.fn.Return<DirectConsumer> {
  let last = 0
  let pending = -1
  const notifications = yield* PubSub.sliding<T.ConsumerNotification>(64)
  const options = (limits: DirectBatchLimits = {}): T.DirectBatchOptions => {
    const first = last > 0 ? { seq: last + 1 } : "start_time" in start ? start : { seq: Math.max(1, start.seq ?? 1) }
    return { ...first, ...limits, batch: limits.batch ?? 100 }
  }
  const advance = Effect.fnUntraced(function*(message: JetStreamStoredMessage.JetStreamStoredMessage) {
    if (message.lastSequence > 0 && message.lastSequence !== last) {
      yield* PubSub.publish(notifications, { type: "reset", name: "direct" })
      return false
    }
    last = message.seq
    pending = message.pending
    return true
  })
  const fetch = Effect.fnUntraced(function*(limits: DirectBatchLimits = {}) {
    const request = options(limits)
    yield* PubSub.publish(notifications, {
      type: "next",
      options: {
        batch: request.batch ?? 100,
        max_bytes: request.max_bytes ?? 0,
        no_wait: false,
        expires: 0,
        idle_heartbeat: 0
      }
    })
    const messages = yield* api.getBatch(stream, request)
    let reset = false
    return {
      ...messages,
      stream: messages.stream.pipe(
        Stream.takeUntilEffect((message) =>
          advance(message).pipe(Effect.map((ok) => {
            reset = !ok
            return reset
          }))
        ),
        Stream.filter(() => !reset),
        Stream.ensuring(messages.stop())
      )
    }
  })
  const consume = Effect.fnUntraced(function*(limits: DirectBatchLimits = {}): Effect.fn.Return<
    JetStreamDirectStreamAPI.DirectMessages,
    NATSError.JetStreamDirectStreamAPIError,
    Scope.Scope
  > {
    const queue = yield* Queue.make<
      JetStreamStoredMessage.JetStreamStoredMessage,
      NATSError.JetStreamDirectStreamAPIError | Cause.Done
    >({ capacity: limits.batch ?? 100 })
    let received = 0
    let processed = 0
    const closed = yield* Deferred.make<Option.Option<NATSError.JetStreamDirectStreamAPIError>>()
    const round = Effect.scoped(Effect.gen(function*() {
      const messages = yield* fetch(limits)
      yield* messages.stream.pipe(Stream.runForEach((message) => {
        received++
        return Queue.offer(queue, message)
      }))
    }))
    const fiber = yield* round.pipe(
      Effect.repeat(Schedule.forever.pipe(Schedule.addDelay(() => Effect.succeed(pending === 0 ? 2500 : 0)))),
      Effect.catch((error) =>
        Deferred.succeed(closed, Option.some(error)).pipe(Effect.andThen(Queue.fail(queue, error)))
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.ensuring(Deferred.succeed(closed, Option.none())),
      Effect.forkScoped
    )
    const stop = Fiber.interrupt(fiber).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
    yield* Effect.addFinalizer(() => stop)
    return {
      [NATSQueuedIterator.TypeId]: NATSQueuedIterator.TypeId,
      stream: Stream.fromQueue(queue).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            processed++
          })
        ),
        Stream.ensuring(stop)
      ),
      stop: () => stop,
      closed: Deferred.await(closed),
      getProcessed: Effect.sync(() => processed),
      getReceived: Effect.sync(() => received),
      getPending: Queue.size(queue)
    }
  })
  return {
    stream,
    status: Stream.fromPubSub(notifications),
    fetch,
    consume,
    next: Effect.suspend(() =>
      api.getMessage(
        stream,
        last > 0 ?
          { seq: last + 1 } :
          "start_time" in start
          ? start
          : { seq: Math.max(1, start.seq ?? 1) }
      )
    ).pipe(
      Effect.tap((message) =>
        Option.match(message, {
          onNone: () => Effect.void,
          onSome: (value) =>
            Effect.sync(() => {
              last = value.seq
              pending = value.pending
            })
        })
      )
    )
  }
})
