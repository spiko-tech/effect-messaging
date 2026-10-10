/**
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Api from "./internal/jetstreamApi.ts"
import * as JetStreamDirectConsumer from "./JetStreamDirectConsumer.ts"
import * as JetStreamStoredMessage from "./JetStreamStoredMessage.ts"
import type * as T from "./JetStreamTypes.ts"
import * as NATSError from "./NATSError.ts"
import * as NATSQueuedIterator from "./NATSQueuedIterator.ts"

/** @since 0.1.0 */
export const TypeId: unique symbol = Symbol.for("@effect-messaging/nats/JetStreamDirectStreamAPI")
/** @since 0.1.0 */
export type TypeId = typeof TypeId
/** @since 0.1.0 */
export interface DirectMessages {
  readonly [NATSQueuedIterator.TypeId]: NATSQueuedIterator.TypeId
  readonly stream: Stream.Stream<JetStreamStoredMessage.JetStreamStoredMessage, NATSError.JetStreamDirectStreamAPIError>
  readonly stop: () => Effect.Effect<void>
  readonly getProcessed: Effect.Effect<number>
  readonly getReceived: Effect.Effect<number>
  readonly getPending: Effect.Effect<number>
  /** Completes when the stream or callback worker stops. @since 1.0.0 */
  readonly closed: Effect.Effect<Option.Option<NATSError.JetStreamDirectStreamAPIError>>
}
/** @since 0.1.0 */
export interface JetStreamDirectStreamAPI {
  readonly [TypeId]: TypeId
  readonly getMessage: (stream: string, query: T.DirectMsgRequest) => Effect.Effect<
    Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>,
    NATSError.JetStreamDirectStreamAPIError
  >
  readonly getBatch: (stream: string, options: T.DirectBatchOptions) => Effect.Effect<
    DirectMessages,
    NATSError.JetStreamDirectStreamAPIError,
    Scope.Scope
  >
  readonly getConsumer: (
    stream: string,
    start?: JetStreamDirectConsumer.DirectStartOptions
  ) => Effect.Effect<JetStreamDirectConsumer.DirectConsumer>
  readonly getLastMessagesFor: (stream: string, options: T.DirectLastFor) => Effect.Effect<
    DirectMessages,
    NATSError.JetStreamDirectStreamAPIError,
    Scope.Scope
  >
}
const normalize = (options: object) =>
  Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])
  )

/** @internal */
export const make = (api: Api.JetStreamApi): JetStreamDirectStreamAPI => {
  const mapError = Api.mapError(NATSError.JetStreamDirectStreamAPIError)
  const batch = Effect.fn("JetStreamDirectStreamAPI.batch")(
    function*(
      stream: string,
      options: T.DirectBatchOptions | T.DirectLastFor
    ): Effect.fn.Return<DirectMessages, NATSError.JetStreamDirectStreamAPIError, Scope.Scope> {
      yield* api.requireVersion("Direct batch reads", [2, 11, 0]).pipe(mapError)
      yield* api.validateName("stream", stream).pipe(mapError)
      if (!("seq" in options) && !("start_time" in options) && !("multi_last" in options)) {
        return yield* new NATSError.JetStreamDirectStreamAPIError({
          reason: "empty request: a start option is required"
        })
      }
      if ("seq" in options && "start_time" in options) {
        return yield* new NATSError.JetStreamDirectStreamAPIError({
          reason: "seq and start_time are mutually exclusive"
        })
      }
      const inbox = yield* api.connection.createInbox
      const sub = yield* api.connection.subscribe(inbox).pipe(mapError)
      yield* Effect.addFinalizer(() => sub.unsubscribe().pipe(Effect.ignore))
      yield* api.connection.publish(`${api.prefix}.DIRECT.GET.${stream}`, JSON.stringify(normalize(options)), {
        reply: inbox
      }).pipe(mapError)
      const queue = yield* Queue.make<
        JetStreamStoredMessage.JetStreamStoredMessage,
        NATSError.JetStreamDirectStreamAPIError | Cause.Done
      >({ capacity: "batch" in options ? options.batch || 1024 : 1024 })
      let received = 0
      let processed = 0
      let consuming = false
      const closed = yield* Deferred.make<Option.Option<NATSError.JetStreamDirectStreamAPIError>>()
      const source = sub.stream.pipe(
        Stream.timeoutOrElse({
          duration: api.timeout,
          orElse: () =>
            Stream.fail(
              new Api.JetStreamApiError({
                reason: "Direct batch response timed out"
              })
            )
        }),
        Stream.takeUntil((message) =>
          Option.match(message.headers, {
            onNone: () => false,
            onSome: (headers) => headers.code > 0
          })
        ),
        Stream.mapEffect(Effect.fnUntraced(function*(message) {
          const header = Option.getOrUndefined(message.headers)
          const code = header?.code ?? 0
          if (code === 204 || (code === 404 && options.callback === undefined)) return Option.none()
          if (code >= 300) {
            return yield* new Api.JetStreamApiError({
              reason: `${code}: ${
                code === 503 ? "no responders" : header?.description || "Direct batch request failed"
              }`
            })
          }
          return Option.some(yield* JetStreamStoredMessage.fromDirect(message))
        })),
        Stream.filter(Option.isSome),
        Stream.map((message) => message.value),
        Api.mapStreamError(NATSError.JetStreamDirectStreamAPIError),
        Stream.ensuring(sub.unsubscribe().pipe(Effect.ignore))
      )
      const producer = yield* source.pipe(
        Stream.runForEach((message) => {
          received++
          return Queue.offer(queue, message)
        }),
        Effect.catch((error) => Queue.fail(queue, error)),
        Effect.ensuring(Queue.end(queue)),
        Effect.forkScoped({ startImmediately: true })
      )
      const stop = Fiber.interrupt(producer).pipe(
        Effect.andThen(sub.unsubscribe().pipe(Effect.ignore)),
        Effect.andThen(Queue.end(queue)),
        Effect.andThen(Deferred.succeed(closed, Option.none())),
        Effect.asVoid
      )
      yield* Effect.addFinalizer(() => stop)
      const messages = Stream.fromQueue(queue).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            processed++
          })
        ),
        Stream.onExit((exit) =>
          Deferred.succeed(closed, exit._tag === "Success" ? Option.none() : Cause.findErrorOption(exit.cause))
        ),
        Stream.ensuring(stop)
      )
      const callback = options.callback
      if (callback !== undefined) {
        const invoke = (
          done: Option.Option<T.CompletionResult>,
          message: Option.Option<JetStreamStoredMessage.JetStreamStoredMessage>
        ) =>
          Effect.suspend(() => {
            return Effect.try({
              try: () => callback(done, message),
              catch: (cause) =>
                new NATSError.JetStreamDirectStreamAPIError({ reason: "Direct batch callback failed", cause })
            }).pipe(Effect.flatMap((result) => Effect.isEffect(result) ? result.pipe(mapError) : Effect.void))
          })
        yield* messages.pipe(
          Stream.runForEach((message) => invoke(Option.none(), Option.some(message))),
          Effect.onExit((exit) =>
            invoke(
              Option.some(
                exit._tag === "Success" ? {} : Option.match(Cause.findErrorOption(exit.cause), {
                  onNone: () => ({}),
                  onSome: (err) => ({ err })
                })
              ),
              Option.none()
            ).pipe(Effect.ignore)
          ),
          Effect.ignore,
          Effect.forkScoped({ startImmediately: true })
        )
      }
      return {
        [NATSQueuedIterator.TypeId]: NATSQueuedIterator.TypeId,
        stream: callback === undefined ?
          Stream.unwrap(Effect.suspend(() => {
            if (consuming) {
              return Effect.succeed(Stream.fail(
                new NATSError.JetStreamDirectStreamAPIError({
                  reason: "Direct batches cannot be consumed concurrently"
                })
              ))
            }
            consuming = true
            return Effect.succeed(messages)
          })) :
          Stream.fail(
            new NATSError.JetStreamDirectStreamAPIError({
              reason: "Callback batches cannot also be consumed as streams"
            })
          ),
        stop: () => stop,
        closed: Deferred.await(closed),
        getProcessed: Effect.sync(() => processed),
        getReceived: Effect.sync(() => received),
        getPending: Effect.sync(() => Math.max(0, received - processed))
      }
    }
  )
  const direct: JetStreamDirectStreamAPI = {
    [TypeId]: TypeId,
    getMessage: Effect.fn("JetStreamDirectStreamAPI.getMessage")(function*(stream, query) {
      yield* api.validateName("stream", stream)
      if ("start_time" in query) yield* api.requireVersion("start_time direct reads", [2, 11, 0])
      const last = "last_by_subj" in query ? query.last_by_subj : undefined
      const subject = `${api.prefix}.DIRECT.GET.${stream}${last ? `.${last}` : ""}`
      const message = yield* api.connection.request(subject, last ? undefined : JSON.stringify(normalize(query)), {
        timeout: api.timeout
      })
      const code = Option.getOrUndefined(message.headers)?.code ?? 0
      if (code === 404) return Option.none()
      if (code >= 300) {
        return yield* new Api.JetStreamApiError({
          reason: Option.getOrUndefined(message.headers)?.description ?? `Direct request status ${code}`
        })
      }
      return Option.some(yield* JetStreamStoredMessage.fromDirect(message))
    }, mapError),
    getBatch: (stream, options) => batch(stream, { ...options, batch: options.batch || 1024 }),
    getLastMessagesFor: batch,
    getConsumer: (stream, start) => JetStreamDirectConsumer.make(direct, stream, start)
  }
  return direct
}
