/**
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Take from "effect/Take"
import * as Heartbeat from "./internal/heartbeat.ts"
import * as Api from "./internal/jetstreamApi.ts"
import * as JetStreamConsumerAPI from "./JetStreamConsumerAPI.ts"
import * as JetStreamMessage from "./JetStreamMessage.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSError from "./NATSError.ts"
import type * as NATSMessage from "./NATSMessage.ts"
import * as NATSQueuedIterator from "./NATSQueuedIterator.ts"

/** @since 0.1.0 */
export const CloseTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Close")
/** @since 0.1.0 */
export type CloseTypeId = typeof CloseTypeId
/** @since 0.1.0 */
export interface Close {
  readonly [CloseTypeId]: CloseTypeId
  readonly close: Effect.Effect<void, NATSError.JetStreamConsumerError>
  readonly closed: Effect.Effect<void, NATSError.JetStreamConsumerError>
}
/** @since 0.1.0 */
export const ConsumerMessagesTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ConsumerMessages")
/** @since 0.1.0 */
export type ConsumerMessagesTypeId = typeof ConsumerMessagesTypeId
/** @since 0.1.0 */
export interface ConsumerMessages extends Close {
  readonly [ConsumerMessagesTypeId]: ConsumerMessagesTypeId
  readonly [NATSQueuedIterator.TypeId]: NATSQueuedIterator.TypeId
  readonly stream: Stream.Stream<JetStreamMessage.JetStreamMessage, NATSError.JetStreamConsumerError>
  readonly stop: (error?: Error) => Effect.Effect<void>
  readonly getProcessed: Effect.Effect<number>
  readonly getPending: Effect.Effect<number>
  readonly getReceived: Effect.Effect<number>
  readonly status: Effect.Effect<Stream.Stream<T.ConsumerNotification>>
}
/** @since 0.1.0 */
export const ConsumerKindTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ConsumerKind")
/** @since 0.1.0 */
export type ConsumerKindTypeId = typeof ConsumerKindTypeId
/** @since 0.1.0 */
export interface ConsumerKind {
  readonly [ConsumerKindTypeId]: ConsumerKindTypeId
  readonly isPullConsumer: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
  readonly isPushConsumer: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
}
/** @since 0.1.0 */
export const ExportedConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/ExportedConsumer")
/** @since 0.1.0 */
export type ExportedConsumerTypeId = typeof ExportedConsumerTypeId
/** @since 0.1.0 */
export interface ExportedConsumer extends ConsumerKind {
  readonly [ExportedConsumerTypeId]: ExportedConsumerTypeId
  readonly next: (options?: T.NextOptions) => Effect.Effect<
    Option.Option<JetStreamMessage.JetStreamMessage>,
    NATSError.JetStreamConsumerError
  >
  readonly fetch: (options?: T.FetchOptions) => Effect.Effect<
    ConsumerMessages,
    NATSError.JetStreamConsumerError,
    Scope.Scope
  >
  readonly consume: (options?: T.ConsumeOptions) => Effect.Effect<
    ConsumerMessages,
    NATSError.JetStreamConsumerError,
    Scope.Scope
  >
}
/** @since 0.1.0 */
export const InfoableConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/InfoableConsumer")
/** @since 0.1.0 */
export type InfoableConsumerTypeId = typeof InfoableConsumerTypeId
/** @since 0.1.0 */
export interface InfoableConsumer {
  readonly [InfoableConsumerTypeId]: InfoableConsumerTypeId
  readonly info: (cached?: boolean) => Effect.Effect<T.ConsumerInfo, NATSError.JetStreamConsumerError>
}
/** @since 0.1.0 */
export const DeleteableConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/DeleteableConsumer")
/** @since 0.1.0 */
export type DeleteableConsumerTypeId = typeof DeleteableConsumerTypeId
/** @since 0.1.0 */
export interface DeleteableConsumer {
  readonly [DeleteableConsumerTypeId]: DeleteableConsumerTypeId
  readonly delete: Effect.Effect<boolean, NATSError.JetStreamConsumerError>
}
/** @since 0.1.0 */
export const ConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Consumer")
/** @since 0.1.0 */
export type ConsumerTypeId = typeof ConsumerTypeId
/** @since 0.1.0 */
export interface Consumer extends ExportedConsumer, InfoableConsumer, DeleteableConsumer {
  readonly [ConsumerTypeId]: ConsumerTypeId
}
/** @since 0.1.0 */
export const PushConsumerTypeId: unique symbol = Symbol.for("@effect-messaging/nats/PushConsumer")
/** @since 0.1.0 */
export type PushConsumerTypeId = typeof PushConsumerTypeId
/** @since 0.1.0 */
export interface PushConsumer extends InfoableConsumer, DeleteableConsumer, ConsumerKind {
  readonly [PushConsumerTypeId]: PushConsumerTypeId
  readonly consume: (options?: T.PushConsumerOptions) => Effect.Effect<
    ConsumerMessages,
    NATSError.JetStreamConsumerError,
    Scope.Scope
  >
}
/** @since 0.1.0 */
export const ConsumersTypeId: unique symbol = Symbol.for("@effect-messaging/nats/Consumers")
/** @since 0.1.0 */
export type ConsumersTypeId = typeof ConsumersTypeId
/** @since 0.1.0 */
export interface Consumers {
  readonly [ConsumersTypeId]: ConsumersTypeId
  readonly get: (
    stream: string,
    name?: string | Partial<T.OrderedConsumerOptions>
  ) => Effect.Effect<Consumer, NATSError.JetStreamConsumerError>
  readonly getConsumerFromInfo: (info: T.ConsumerInfo) => Effect.Effect<Consumer, NATSError.JetStreamConsumerError>
  readonly getPushConsumer: (
    stream: string,
    name?: string | Partial<T.OrderedPushConsumerOptions>
  ) => Effect.Effect<PushConsumer, NATSError.JetStreamConsumerError>
  readonly getBoundPushConsumer: (
    options: T.BoundPushConsumerOptions
  ) => Effect.Effect<PushConsumer, NATSError.JetStreamConsumerError>
}

interface ConsumerState {
  info: T.ConsumerInfo
  lastSequence: number
  deliverySequence: number
  active: boolean
  mode?: "fetch" | "consume"
  needsRecreate?: boolean
}
const consumerState = (info: T.ConsumerInfo): ConsumerState => ({
  info,
  lastSequence: (info.config.opt_start_seq ?? 1) - 1,
  deliverySequence: 0,
  active: false
})
class HeartbeatMissed extends Schema.TaggedError<HeartbeatMissed>()("HeartbeatMissed", {}) {}
class OrderedReset extends Schema.TaggedError<OrderedReset>()("OrderedReset", {}) {}
const Positive = Schema.Number.check(Schema.isGreaterThan(0), Schema.isInt())
const mapError = Api.mapError(NATSError.JetStreamConsumerError)
const statusCode = (message: NATSMessage.NATSMessage) =>
  Option.match(message.headers, {
    onNone: () => 0,
    onSome: (headers) => headers.code
  })
const unique = () => crypto.randomUUID().replaceAll("-", "")

/** @internal */
const makeMessages = Effect.fnUntraced(function*(
  api: Api.JetStreamApi,
  state: ConsumerState | undefined,
  push: T.BoundPushConsumerOptions | undefined,
  options: T.ConsumeOptions,
  continuous: boolean,
  ordered = false
): Effect.fn.Return<ConsumerMessages, NATSError.JetStreamConsumerError, Scope.Scope> {
  if (
    ordered &&
    (options.group !== undefined || options.min_pending !== undefined || options.min_ack_pending !== undefined)
  ) {
    return yield* new NATSError.JetStreamConsumerError({ reason: "Ordered consumers do not support priority groups" })
  }
  if (options.group !== undefined || options.min_pending !== undefined || options.min_ack_pending !== undefined) {
    yield* api.requireVersion("Consumer priority groups", [2, 11, 0]).pipe(mapError)
  }
  if (options.max_bytes) yield* api.requireVersion("Consumer byte limits", [2, 8, 3]).pipe(mapError)
  if (options.max_messages && options.max_bytes) {
    return yield* new NATSError.JetStreamConsumerError({ reason: "max_messages and max_bytes are mutually exclusive" })
  }
  if (options.group !== undefined) {
    yield* api.validateName("priority group", options.group).pipe(mapError)
    if (options.group.length > 16) {
      return yield* new NATSError.JetStreamConsumerError({ reason: "group must be 16 characters or less" })
    }
  }
  for (const value of [options.min_pending, options.min_ack_pending, options.priority]) {
    if (value !== undefined) {
      yield* Schema.decodeUnknownEffect(Schema.Number.check(Schema.isFinite()))(value).pipe(mapError)
    }
  }
  if (options.max_bytes) yield* Schema.decodeUnknownEffect(Positive)(options.max_bytes).pipe(mapError)
  if (options.threshold_bytes) yield* Schema.decodeUnknownEffect(Positive)(options.threshold_bytes).pipe(mapError)
  const maxMessages = yield* Schema.decodeUnknownEffect(Positive)(options.max_messages || 100).pipe(mapError)
  const threshold = yield* Schema.decodeUnknownEffect(Positive)(
    options.threshold_messages || Math.max(1, Math.round(maxMessages * 0.75))
  ).pipe(mapError)
  if (threshold > maxMessages) {
    return yield* new NATSError.JetStreamConsumerError({ reason: "threshold_messages must not exceed max_messages" })
  }
  const expires = yield* Schema.decodeUnknownEffect(Positive)(options.expires || 30_000).pipe(mapError)
  if (expires < 1000) return yield* new NATSError.JetStreamConsumerError({ reason: "expires must be at least 1000ms" })
  if (options.bind && options.abort_on_missing_resource) {
    return yield* new NATSError.JetStreamConsumerError({ reason: "bind and abort_on_missing_resource are exclusive" })
  }
  const queue = yield* Queue.make<JetStreamMessage.JetStreamMessage, NATSError.JetStreamConsumerError | Cause.Done>({
    capacity: maxMessages
  })
  const notifications = yield* PubSub.sliding<Take.Take<T.ConsumerNotification>>({ capacity: 64, replay: 64 })
  const closed = yield* Deferred.make<void, NATSError.JetStreamConsumerError>()
  const pinnedDemand = options.group !== undefined && options.min_pending === undefined &&
    options.min_ack_pending === undefined
  let resumeDemand: Effect.Effect<void, NATSError.JetStreamConsumerError> = Effect.void
  let callbackDemand: Effect.Effect<void, NATSError.JetStreamConsumerError> = Effect.void
  const callbackQueue = options.callback
    ? yield* Queue.bounded<JetStreamMessage.JetStreamMessage>(maxMessages)
    : undefined
  let callbacksCompleted = 0
  let callbacksExpected = 0
  const callbackProgress = Latch.makeUnsafe()
  const deliveryCapacity = Latch.makeUnsafe()
  let heartbeatMisses = 1
  let missingConsumerCount = 0
  let orderedCreateFailures = 0
  let received = 0
  let processed = 0
  if (ordered && state?.mode && state.mode !== (continuous ? "consume" : "fetch")) {
    return yield* new NATSError.JetStreamConsumerError({ reason: `ordered consumer initialized as ${state.mode}` })
  }
  if (ordered && state?.active) {
    return yield* new NATSError.JetStreamConsumerError({
      reason: `ordered consumer doesn't support concurrent ${continuous ? "consume" : "fetch"}`
    })
  }
  if (ordered && options.bind) {
    return yield* new NATSError.JetStreamConsumerError({ reason: "'bind' is not supported" })
  }
  if (ordered && state) state.mode = continuous ? "consume" : "fetch"
  if (state) state.active = true
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (state) state.active = false
    })
  )
  const consumerAPI = JetStreamConsumerAPI.make(api)
  const notify = (event: T.ConsumerNotification) => PubSub.publish(notifications, [event]).pipe(Effect.asVoid)
  const recreate = Effect.fnUntraced(function*() {
    if (!state) return
    const current = state.info
    const config: Partial<T.ConsumerConfig> = {
      ...current.config,
      name: `${current.name.slice(0, current.name.lastIndexOf("_")) || "ordered"}_${unique()}`,
      deliver_policy: "by_start_sequence",
      opt_start_seq: state.lastSequence + 1
    }
    delete config.durable_name
    if (config.deliver_subject) {
      const prefix = config.deliver_subject.slice(0, config.deliver_subject.lastIndexOf(".")) || "_INBOX"
      config.deliver_subject = `${prefix}.${unique()}`
    }
    delete config.opt_start_time
    const info = yield* consumerAPI.add(current.stream_name, config).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          orderedCreateFailures++
          heartbeatMisses++
        }).pipe(
          Effect.andThen(
            /stream not found/i.test(error.reason)
              ? notify({ type: "stream_not_found", name: current.stream_name })
              : Effect.void
          ),
          Effect.andThen(Effect.suspend(() => notify({ type: "heartbeats_missed", count: heartbeatMisses })))
        )
      ),
      Effect.retry({
        while: () => orderedCreateFailures < 30 || received > 0,
        schedule: Schedule.forever.pipe(
          Schedule.addDelay(({ output }) =>
            Effect.succeed([0, 250, 250, 500, 500, 3000, 5000][Math.min(output, 6)] ?? 5000)
          )
        )
      }),
      Effect.tap(() =>
        Effect.sync(() => {
          orderedCreateFailures = 0
        })
      ),
      mapError
    )
    state.info = info
    state.needsRecreate = false
    state.deliverySequence = 0
    yield* consumerAPI.delete(current.stream_name, current.name).pipe(Effect.ignore)
    yield* notify({ type: "ordered_consumer_recreated", name: info.name })
  })
  const round = Effect.fnUntraced(function*() {
    if (ordered && state?.needsRecreate) yield* recreate()
    const connectionState = yield* api.connection.state
    const ci = state?.info
    const subject = ci?.config.deliver_subject ?? push?.deliver_subject ?? (yield* api.connection.createInbox)
    const group = ci?.config.deliver_group ?? push?.deliver_group
    const subscription = yield* api.connection.subscribe(subject, group ? { queue: group } : {}).pipe(mapError)
    yield* Effect.addFinalizer(() => subscription.unsubscribe().pipe(Effect.ignore))
    let count = 0
    let pinId = ""
    let pendingMessages = 0
    let pendingBytes = 0
    const pulling = !ci?.config.deliver_subject && !push
    const heartbeat = Math.min(30_000, Math.max(500, options.idle_heartbeat || expires / 2))
    const pull = Effect.fnUntraced(function*(batch: number, bytes: number) {
      if (!ci) return yield* new NATSError.JetStreamConsumerError({ reason: "Missing consumer information" })
      const payload = {
        batch,
        expires: expires * 1_000_000,
        idle_heartbeat: heartbeat * 1_000_000,
        ...(bytes ? { max_bytes: bytes } : {}),
        ...(options.group ? { group: options.group } : {}),
        ...(pinId ? { id: pinId } : {}),
        ...(options.min_pending === undefined ? {} : { min_pending: options.min_pending }),
        ...(options.min_ack_pending === undefined ? {} : { min_ack_pending: options.min_ack_pending }),
        ...(options.priority === undefined ? {} : { priority: options.priority })
      }
      pendingMessages += batch
      pendingBytes += bytes
      yield* api.connection.publish(
        `${api.prefix}.CONSUMER.MSG.NEXT.${ci.stream_name}.${ci.name}`,
        JSON.stringify(payload),
        { reply: subject }
      ).pipe(mapError)
      yield* notify({ type: "next", options: { max_bytes: 0, no_wait: false, ...payload } })
    })
    const refill = Effect.fnUntraced(function*() {
      if (!continuous || !pulling) return
      const bytesThreshold = options.threshold_bytes ?? Math.max(1, Math.round((options.max_bytes ?? 0) * 0.75))
      if (options.max_bytes ? pendingBytes <= bytesThreshold : pendingMessages <= threshold) {
        yield* pull(Math.max(1, maxMessages - pendingMessages), Math.max(0, (options.max_bytes ?? 0) - pendingBytes))
      }
    })
    if (pulling) yield* pull(maxMessages, options.max_bytes ?? 0)
    const idleHeartbeat = ci?.config.deliver_subject
      ? (ci.config.idle_heartbeat ?? 0) / 1_000_000
      : push
      ? (push.idle_heartbeat ?? 0) / 1_000_000
      : heartbeat
    const heartbeatExpired = yield* Deferred.make<void>()
    const monitor = idleHeartbeat > 0
      ? yield* Heartbeat.make(
        idleHeartbeat,
        () => Deferred.succeed(heartbeatExpired, undefined).pipe(Effect.as(true)),
        {
          maxOut: 2
        }
      )
      : undefined
    let deliveryBlocked = false
    const currentDemand = Effect.gen(function*() {
      if (monitor && !deliveryBlocked) yield* monitor.restart
      yield* refill()
    })
    callbackDemand = currentDemand
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (callbackDemand === currentDemand) callbackDemand = Effect.void
        resumeDemand = Effect.void
      })
    )
    const retain = Effect.fnUntraced(function*(jsMessage: JetStreamMessage.JetStreamMessage) {
      const admit = Effect.sync(() => {
        Latch.closeUnsafe(deliveryCapacity)
        if (!Queue.offerUnsafe(callbackQueue ?? queue, jsMessage)) return false
        // Admission and cursor advancement must be atomic with respect to recovery.
        if (state) {
          state.deliverySequence = jsMessage.info.deliverySequence
          state.lastSequence = jsMessage.seq
        }
        if (callbackQueue) callbacksExpected++
        return true
      })
      if (yield* admit) return
      deliveryBlocked = true
      // The reader cannot observe heartbeats while application demand is paused.
      if (monitor) yield* monitor.cancel
      do {
        yield* deliveryCapacity.await
      } while (!(yield* admit))
      deliveryBlocked = false
      if (monitor && (!pulling || pendingMessages > 0)) yield* monitor.restart
    })
    const source = subscription.stream.pipe(
      Stream.tap(() => monitor?.work ?? Effect.void),
      Stream.takeUntil((message) => !continuous && statusCode(message) >= 300),
      Stream.runForEach(Effect.fnUntraced(function*(message) {
        const code = statusCode(message)
        if (code === 100) {
          heartbeatMisses = 1
          const headers = Option.getOrUndefined(message.headers)
          if (Option.isSome(message.reply)) {
            yield* message.respond().pipe(mapError)
            yield* notify({ type: "flow_control" })
          } else {
            const stalled = headers?.get("Nats-Consumer-Stalled")
            if (stalled) yield* api.connection.publish(stalled).pipe(mapError)
            const lastConsumerSequence = yield* Schema.decodeUnknownEffect(
              Schema.NumberFromString.check(Schema.isFinite())
            )(
              headers?.get("Nats-Last-Consumer") || "0"
            ).pipe(mapError)
            const lastStreamSequence = yield* Schema.decodeUnknownEffect(
              Schema.NumberFromString.check(Schema.isFinite())
            )(
              headers?.get("Nats-Last-Stream") || "0"
            ).pipe(mapError)
            if (ordered && lastConsumerSequence !== (state?.deliverySequence ?? 0)) return yield* new OrderedReset({})
            yield* notify({ type: "heartbeat", lastConsumerSequence, lastStreamSequence })
          }
          return
        }
        if (code >= 300 && pulling) {
          const headers = Option.getOrUndefined(message.headers)
          const messagesLeft = yield* Schema.decodeUnknownEffect(Schema.NumberFromString.check(Schema.isFinite()))(
            headers?.get("Nats-Pending-Messages") || "0"
          ).pipe(mapError)
          const bytesLeft = yield* Schema.decodeUnknownEffect(Schema.NumberFromString.check(Schema.isFinite()))(
            headers?.get("Nats-Pending-Bytes") || "0"
          ).pipe(mapError)
          pendingMessages = Math.max(0, pendingMessages - messagesLeft)
          pendingBytes = Math.max(0, pendingBytes - bytesLeft)
          if (messagesLeft || bytesLeft) yield* notify({ type: "discard", messagesLeft, bytesLeft })
        }
        if (code === 423 && continuous) {
          pinId = ""
          yield* notify({ type: "consumer_unpinned" })
          yield* refill()
          return
        }
        if (code === 503) {
          yield* notify({ type: "no_responders", code })
          if (continuous) {
            if (options.abort_on_missing_resource && state) {
              yield* consumerAPI.info(state.info.stream_name, state.info.name)
            }
            if (ordered) return yield* new OrderedReset({})
            return
          }
          if (ordered && state) state.needsRecreate = true
        }
        if (code === 408) {
          yield* refill()
          return
        }
        if (code === 404 && !Option.getOrUndefined(message.headers)?.description.toLowerCase().includes("consumer")) {
          yield* refill()
          return
        }
        if (code >= 300) {
          const description = Option.getOrUndefined(message.headers)?.description ||
            (code === 503 ? "No responders" : "Consumer request failed")
          if (
            continuous && code === 409 && /consumer deleted/i.test(description) &&
            options.abort_on_missing_resource && state
          ) {
            yield* api.api(
              `STREAM.INFO.${state.info.stream_name}`,
              {},
              Schema.Struct({ config: Schema.Struct({ name: Schema.String }) })
            )
          }
          if (
            continuous && code === 409 && /server shutdown|leadership change|raft.*(leader|quorum)/i.test(description)
          ) {
            return yield* ordered ? new OrderedReset({}) : new HeartbeatMissed({})
          }
          if (code === 409 && description.toLowerCase() === "batch completed") {
            yield* refill()
            return
          }
          if (code === 409 && description.toLowerCase().includes("max")) {
            yield* notify({ type: "exceeded_limits", code, description })
            if (continuous && /maxrequest(batch|expires)/i.test(description)) return
            if (continuous && /max\s*waiting/i.test(description)) return
            if (description.toLowerCase() === "message size exceeds maxbytes" && continuous) {
              if (count > 0) yield* refill()
              return
            }
            if (description.toLowerCase() === "message size exceeds maxbytes" && count > 0) return
          } else if (code === 409) yield* notify({ type: "consumer_deleted", code, description })
          if (ordered && continuous && !options.abort_on_missing_resource && (code === 409 || code === 404)) {
            return yield* new OrderedReset({})
          }
          return yield* new NATSError.JetStreamConsumerError({ reason: `${code}: ${description}` })
        }
        heartbeatMisses = 1
        missingConsumerCount = 0
        const jsMessage = yield* JetStreamMessage.make(message, api.connection, api.timeout).pipe(mapError)
        if (ordered && jsMessage.info.deliverySequence !== (state?.deliverySequence ?? 0) + 1) {
          return yield* new OrderedReset({})
        }
        if (options.group && options.min_pending === undefined && options.min_ack_pending === undefined && !pinId) {
          const id = Option.getOrUndefined(message.headers)?.get("Nats-Pin-Id")
          if (id) {
            pinId = id
            yield* notify({ type: "consumer_pinned", id })
          }
        }
        count++
        pendingMessages = Math.max(0, pendingMessages - 1)
        if (options.max_bytes) pendingBytes = Math.max(0, pendingBytes - message.size)
        received++
        if (callbackQueue) {
          if (monitor && pulling && pendingMessages === 0) yield* monitor.cancel
        } else {
          if (pinnedDemand) {
            if (monitor && pendingMessages === 0) yield* monitor.cancel
            resumeDemand = Effect.gen(function*() {
              if (monitor) yield* monitor.restart
              yield* refill()
            })
          } else yield* refill()
        }
        yield* retain(jsMessage)
        if (!continuous && count >= maxMessages) {
          yield* subscription.unsubscribe().pipe(mapError)
        }
      }))
    )
    const disconnected = api.connection.changes.pipe(
      Stream.filter((current) => current.state === "Connected" && current.generation > connectionState.generation),
      Stream.runHead,
      Effect.andThen(Effect.fail(ordered ? new OrderedReset({}) : new HeartbeatMissed({})))
    )
    const reading = (continuous || !pulling ? source : source.pipe(Effect.timeoutOption(expires + 1000), Effect.asVoid))
      .pipe(Effect.andThen(Effect.gen(function*() {
        while (true) {
          if (!callbackQueue || callbacksCompleted >= callbacksExpected) break
          Latch.closeUnsafe(callbackProgress)
          if (callbacksCompleted < callbacksExpected) yield* callbackProgress.await
        }
      })))
    const heartbeatFailure = Deferred.await(heartbeatExpired).pipe(
      Effect.andThen(Effect.sync(() => {
        heartbeatMisses++
      })),
      Effect.andThen(Effect.suspend(() => notify({ type: "heartbeats_missed", count: heartbeatMisses }))),
      Effect.andThen(Effect.fail(ordered ? new OrderedReset({}) : new HeartbeatMissed({})))
    )
    const controlFailure = monitor ? Effect.raceFirst(disconnected, heartbeatFailure) : disconnected
    yield* Effect.raceFirst(reading, controlFailure)
  })
  const runRound = Effect.scoped(round()).pipe(
    Effect.tapError((error) => error instanceof OrderedReset ? recreate() : Effect.void),
    Effect.retry({ while: (error) => error instanceof OrderedReset, schedule: Schedule.forever }),
    Effect.catchTag(
      "HeartbeatMissed",
      (): Effect.Effect<void, NATSError.JetStreamConsumerError | NATSError.JetStreamConsumerAPIError> =>
        !continuous
          ? Effect.fail(new NATSError.JetStreamConsumerError({ reason: "Consumer heartbeats missed" }))
          : state && !options.bind
          ? consumerAPI.info(state.info.stream_name, state.info.name).pipe(
            Effect.tap((info) =>
              Effect.sync(() => {
                state.info = info
              })
            ),
            Effect.asVoid
          )
          : Effect.void
    ),
    mapError
  )
  const recoveringRound = continuous && !options.abort_on_missing_resource
    ? runRound.pipe(
      Effect.tapError((error) => {
        if (state && /consumer not found/i.test(error.reason)) {
          return notify({
            type: "consumer_not_found",
            name: state.info.name,
            stream: state.info.stream_name,
            count: ++missingConsumerCount
          })
        }
        if (state && /stream not found/i.test(error.reason)) {
          return notify({ type: "stream_not_found", name: state.info.stream_name })
        }
        return Effect.void
      }),
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        while: (error) =>
          (orderedCreateFailures < 30 || received > 0) &&
          /404|503|heartbeat|responders|timeout|timed\s*out|consumer not found|stream not found|409: consumer (deleted|not found)/i
            .test(error.reason)
      })
    )
    : runRound
  const callbackWorker = options.callback && callbackQueue
    ? yield* Effect.gen(function*() {
      while (true) {
        const jsMessage = yield* Queue.take(callbackQueue)
        Latch.openUnsafe(deliveryCapacity)
        processed++
        const callback = options.callback
        if (!callback) return
        const result = yield* Effect.try({
          try: () => callback(jsMessage),
          catch: (cause) => new NATSError.JetStreamConsumerError({ reason: "Consumer callback failed", cause })
        })
        if (Effect.isEffect(result)) yield* result.pipe(mapError)
        yield* Effect.suspend(() => callbackDemand)
        callbacksCompleted++
        Latch.openUnsafe(callbackProgress)
      }
    }).pipe(Effect.forkScoped)
    : undefined
  const networkProducer = continuous ? recoveringRound.pipe(Effect.repeat(Schedule.forever), Effect.asVoid) : runRound
  const producer = (callbackWorker ? Effect.raceFirst(networkProducer, Fiber.join(callbackWorker)) : networkProducer)
    .pipe(
      Effect.catch((error) => Deferred.fail(closed, error).pipe(Effect.andThen(Queue.fail(queue, error)))),
      Effect.ensuring(callbackWorker ? Fiber.interrupt(callbackWorker) : Effect.void),
      Effect.ensuring(Queue.end(queue)),
      Effect.ensuring(PubSub.end(notifications, Exit.succeed(undefined))),
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.ensuring(Effect.sync(() => {
        if (state) state.active = false
      }))
    )
  const fiber = yield* Effect.forkScoped(producer)
  const close = Fiber.interrupt(fiber).pipe(
    Effect.andThen(Queue.end(queue)),
    Effect.andThen(Effect.sync(() => {
      if (state) state.active = false
    })),
    Effect.asVoid
  )
  yield* Effect.addFinalizer(() => close)
  const stream = options.callback
    ? Stream.fail(
      new NATSError.JetStreamConsumerError({ reason: "iterator cannot be used when a callback is registered" })
    )
    : (pinnedDemand
      ? Stream.fromPull(Effect.succeed(Effect.gen(function*() {
        const demand = resumeDemand
        resumeDemand = Effect.void
        yield* demand
        const message = yield* Queue.take(queue)
        return [message]
      })))
      : Stream.fromQueue(queue)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            Latch.openUnsafe(deliveryCapacity)
            processed++
          })
        ),
        Stream.ensuring(close)
      )
  return {
    [ConsumerMessagesTypeId]: ConsumerMessagesTypeId,
    [NATSQueuedIterator.TypeId]: NATSQueuedIterator.TypeId,
    [CloseTypeId]: CloseTypeId,
    stream,
    close,
    closed: Deferred.await(closed),
    stop: (error) =>
      close.pipe(
        Effect.andThen(
          error
            ? Queue.fail(queue, new NATSError.JetStreamConsumerError({ reason: error.message, cause: error }))
            : Effect.void
        ),
        Effect.asVoid
      ),
    getProcessed: Effect.sync(() => processed),
    getReceived: Effect.sync(() => received),
    getPending: Queue.size(queue),
    status: Effect.succeed(Stream.fromPubSubTake(notifications))
  }
})

/** @internal */
export const makeConsumer = (api: Api.JetStreamApi, initial: T.ConsumerInfo, ordered = false): Consumer => {
  const consumerAPI = JetStreamConsumerAPI.make(api)
  const state = consumerState(initial)
  const fetch: Consumer["fetch"] = (options = {}) => makeMessages(api, state, undefined, options, false, ordered)
  return {
    [ConsumerTypeId]: ConsumerTypeId,
    [ExportedConsumerTypeId]: ExportedConsumerTypeId,
    [ConsumerKindTypeId]: ConsumerKindTypeId,
    [InfoableConsumerTypeId]: InfoableConsumerTypeId,
    [DeleteableConsumerTypeId]: DeleteableConsumerTypeId,
    isPullConsumer: Effect.succeed(!initial.config.deliver_subject),
    isPushConsumer: Effect.succeed(Boolean(initial.config.deliver_subject)),
    fetch,
    consume: (options = {}) => makeMessages(api, state, undefined, options, true, ordered),
    next: (options = {}) =>
      Effect.scoped(Effect.gen(function*() {
        const messages = yield* fetch({ ...options, max_messages: 1 })
        return yield* messages.stream.pipe(Stream.runHead)
      })),
    info: (cache = false) =>
      cache ? Effect.succeed(state.info) : consumerAPI.info(state.info.stream_name, state.info.name).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            state.info = value
          })
        ),
        mapError
      ),
    delete: Effect.suspend(() => consumerAPI.delete(state.info.stream_name, state.info.name)).pipe(mapError)
  }
}

/** @internal */
export const makePushConsumer = (
  api: Api.JetStreamApi,
  initial: T.ConsumerInfo | undefined,
  bound?: T.BoundPushConsumerOptions,
  ordered = false
): PushConsumer => {
  const state = initial ? consumerState(initial) : undefined
  return {
    [PushConsumerTypeId]: PushConsumerTypeId,
    [ConsumerKindTypeId]: ConsumerKindTypeId,
    [InfoableConsumerTypeId]: InfoableConsumerTypeId,
    [DeleteableConsumerTypeId]: DeleteableConsumerTypeId,
    isPullConsumer: Effect.succeed(false),
    isPushConsumer: Effect.succeed(true),
    consume: (options = {}) =>
      Effect.suspend(() => {
        if (state?.active) {
          return Effect.fail(new NATSError.JetStreamConsumerError({ reason: "consumer already started" }))
        }
        if (state?.info.push_bound && !state.info.config.deliver_group) {
          return Effect.fail(new NATSError.JetStreamConsumerError({ reason: "consumer is already bound" }))
        }
        return makeMessages(
          api,
          state,
          bound,
          {
            ...options,
            ...(bound?.callback ? { callback: bound.callback } : {})
          },
          true,
          ordered
        )
      }),
    info: () =>
      state
        ? JetStreamConsumerAPI.make(api).info(state.info.stream_name, state.info.name).pipe(
          Effect.tap((info) =>
            Effect.sync(() => {
              state.info = info
            })
          ),
          mapError
        )
        : Effect.fail(new NATSError.JetStreamConsumerError({ reason: "Bound consumers do not support info" })),
    delete: state
      ? Effect.suspend(() => JetStreamConsumerAPI.make(api).delete(state.info.stream_name, state.info.name)).pipe(
        mapError
      )
      : Effect.fail(new NATSError.JetStreamConsumerError({ reason: "Bound consumers do not support delete" }))
  }
}

/** @internal */
export const makeConsumers = (api: Api.JetStreamApi): Consumers => {
  const consumerAPI = JetStreamConsumerAPI.make(api)
  const createOrdered = (stream: string, options: Partial<T.OrderedPushConsumerOptions>, push: boolean) =>
    Effect.gen(function*() {
      if (options.name_prefix !== undefined) yield* api.validateName("name_prefix", options.name_prefix)
      const configured = yield* api.configuration
      return yield* consumerAPI.add(stream, {
        ...(options.opt_start_seq === undefined ? {} : { opt_start_seq: options.opt_start_seq }),
        ...(options.opt_start_time === undefined ? {} : { opt_start_time: options.opt_start_time }),
        ...(options.headers_only === undefined ? {} : { headers_only: options.headers_only }),
        ...(options.filter_subjects === undefined ? {} : {
          filter_subjects: typeof options.filter_subjects === "string"
            ? [options.filter_subjects]
            : options.filter_subjects
        }),
        name: `${options.name_prefix ?? "ordered"}_${unique()}`,
        ack_policy: "none",
        max_deliver: 1,
        ...(options.deliver_policy === "last_per_subject" && options.filter_subjects === undefined
          ? { filter_subject: ">" }
          : {}),
        deliver_policy: options.deliver_policy ??
          (options.opt_start_seq ? "by_start_sequence" : options.opt_start_time ? "by_start_time" : "all"),
        replay_policy: options.replay_policy ?? "instant",
        inactive_threshold: options.inactive_threshold ?? 300_000_000_000,
        num_replicas: 1,
        mem_storage: true,
        ...(push
          ? {
            deliver_subject: `${options.deliver_prefix ?? configured.watcherPrefix ?? "_INBOX"}.${unique()}`,
            flow_control: true,
            idle_heartbeat: 5_000_000_000
          }
          : {})
      })
    })
  return {
    [ConsumersTypeId]: ConsumersTypeId,
    get: (stream, name) =>
      api.requireVersion("Consumer framework", [2, 10, 0]).pipe(
        Effect.andThen(
          typeof name === "string"
            ? consumerAPI.info(stream, name)
            : createOrdered(stream, name ?? {}, false)
        ),
        Effect.flatMap((info) =>
          info.config.deliver_subject
            ? Effect.fail(new NATSError.JetStreamConsumerError({ reason: "not a pull consumer" }))
            : Effect.succeed(makeConsumer(api, info, typeof name !== "string"))
        ),
        mapError
      ),
    getConsumerFromInfo: (info) =>
      info.config.deliver_subject
        ? Effect.fail(new NATSError.JetStreamConsumerError({ reason: "not a pull consumer" }))
        : Effect.succeed(makeConsumer(api, info)),
    getPushConsumer: (stream, name) =>
      (typeof name === "string"
        ? consumerAPI.info(stream, name)
        : createOrdered(stream, name ?? {}, true)).pipe(
          Effect.flatMap((info) =>
            info.config.deliver_subject
              ? Effect.succeed(makePushConsumer(api, info, undefined, typeof name !== "string"))
              : Effect.fail(new NATSError.JetStreamConsumerError({ reason: "not a push consumer" }))
          ),
          mapError
        ),
    getBoundPushConsumer: (options) => Effect.succeed(makePushConsumer(api, undefined, options))
  }
}
