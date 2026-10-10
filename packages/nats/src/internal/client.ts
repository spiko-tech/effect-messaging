/** @internal */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Random from "effect/Random"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as NATSAuth from "../NATSAuth.ts"
import type * as NATSConnection from "../NATSConnection.ts"
import * as NATSError from "../NATSError.ts"
import * as NATSInbox from "../NATSInbox.ts"
import * as NATSMessage from "../NATSMessage.ts"
import * as NATSOptions from "../NATSOptions.ts"
import * as NATSSubscription from "../NATSSubscription.ts"
import * as Services from "./clientServices.ts"
import * as Protocol from "./protocol.ts"

type Error = NATSError.NATSConnectionError
type Message = NATSMessage.NATSMessage
interface Subscription {
  id: number
  subject: string
  readonly options: NATSOptions.SubscriptionOptions
  readonly queue: Queue.Queue<Message, NATSError.NATSSubscriptionError | Cause.Done>
  readonly closed: Deferred.Deferred<Option.Option<NATSError.NATSSubscriptionError>>
  readonly empty: Latch.Latch
  readonly first: Deferred.Deferred<void>
  readonly callbackDone: Deferred.Deferred<void>
  handle?: NATSSubscription.NATSSubscription
  received: number
  epochReceived: number
  processed: number
  bytes: number
  max: number | undefined
  stopped: boolean
  draining: boolean
  active: boolean
  slow: boolean
  consuming: boolean
}
interface Outbound {
  readonly data: Uint8Array
  readonly generation?: number
  readonly ping?: Deferred.Deferred<void, Error>
}
interface Epoch {
  readonly generation: number
  readonly server: PoolServer
  readonly writer: Socket.Writer
  readonly failure: Deferred.Deferred<never, Error>
  readonly pongs: Array<Deferred.Deferred<void, Error>>
  readonly info: Deferred.Deferred<NATSOptions.ServerInfo>
  active: boolean
  ready: boolean
  heartbeatPings: number
}
interface Pending {
  readonly subject: string
  readonly mux: boolean
  readonly message: (message: Message) => Effect.Effect<void>
  readonly fail: (error: Error) => void
}
interface PoolServer extends NATSOptions.Server {
  listen: string
  gossiped: boolean
  reconnects: number
  lastConnect: number
  didConnect: boolean
}
const CurrentCallback = Context.Reference<Subscription | undefined>("@effect-messaging/nats/CurrentCallback", {
  defaultValue: () => undefined
})
const encoder = new TextEncoder()
const empty = new Uint8Array()
const error = (reason: string, code: string, cause?: unknown, subject?: string): Error =>
  new NATSError.NATSConnectionError({
    reason,
    code,
    ...(cause === undefined ? {} : { cause }),
    ...(subject === undefined ? {} : { subject })
  })
const subError = (reason: string, cause?: unknown) =>
  new NATSError.NATSSubscriptionError({ reason, ...(cause === undefined ? {} : { cause }) })
const requestFailure = (reason: string, failure: NATSError.NATSSubscriptionError, subject?: string): Error => {
  const cause = failure.cause
  return cause instanceof NATSError.NATSConnectionError && cause.code === "permissions"
    ? error(cause.reason, cause.code, failure, cause.subject)
    : error(reason, "request_error", failure, subject)
}
const complete = <A, E>(deferred: Deferred.Deferred<A, E>, effect: Effect.Effect<A, E>) =>
  Deferred.doneUnsafe(deferred, effect)
const validateSubject = (subject: string, publishing = false): Effect.Effect<void, Error> =>
  typeof subject !== "string" || subject.length === 0 || /\s/.test(subject) || subject.includes("\u0000") ||
    (publishing && /[*>]/.test(subject))
    ? Effect.fail(
      error("Invalid subject", "invalid_subject", undefined, typeof subject === "string" ? subject : undefined)
    )
    : Effect.void
const normalizeServer = (input: string): string => {
  const address = input.trim()
  const bare = !address.includes("://") && !address.startsWith("[") && address.split(":").length > 2
    ? "[" + address + "]"
    : address
  const url = new URL(bare.includes("://") ? bare : "nats://" + bare)
  if (!["nats:", "tls:", "ws:", "wss:"].includes(url.protocol)) throw new globalThis.Error("Invalid server scheme")
  if (url.hostname.length === 0) throw new globalThis.Error("Missing server hostname")
  if (url.port === "") url.port = url.protocol.startsWith("ws") ? (url.protocol === "wss:" ? "443" : "80") : "4222"
  return url.toString()
}
const poolServer = (listen: string, gossiped = false): PoolServer => {
  const url = new URL(listen)
  return {
    listen,
    src: listen,
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
    tlsName: url.hostname.replace(/^\[|\]$/g, ""),
    gossiped,
    reconnects: 0,
    lastConnect: 0,
    didConnect: false
  }
}
const timeout = <A, E, R>(effect: Effect.Effect<A, E, R>, millis: number, reason: string, subject?: string) =>
  effect.pipe(Effect.timeoutOrElse({
    duration: millis,
    orElse: () => Effect.fail(error(reason, "timeout", undefined, subject))
  }))

/** @internal */
export const make = Effect.fnUntraced(function*<R>(
  socketFactory: NATSConnection.SocketFactory<R>,
  options: NATSOptions.ConnectionOptions = {}
): Effect.fn.Return<NATSConnection.NATSConnection, Error, Scope.Scope | R> {
  const scope = yield* Effect.scope
  yield* NATSOptions.validateConnectionOptions(options)
  const initialServers = yield* Effect.try({
    try: () => {
      if (options.servers !== undefined && options.port !== undefined) {
        throw new globalThis.Error("servers and port are mutually exclusive")
      }
      const source = options.servers === undefined
        ? ["nats://localhost:" + (options.port ?? 4222)]
        : typeof options.servers === "string"
        ? [options.servers]
        : options.servers
      if (source.length === 0) throw new globalThis.Error("Server pool cannot be empty")
      return [...new Set(source.map(normalizeServer))]
    },
    catch: (cause) => error("Invalid connection options", "invalid_argument", cause)
  })
  const inboxPrefix = options.inboxPrefix ?? "_INBOX"
  yield* validateSubject(inboxPrefix, true).pipe(
    Effect.mapError((cause) => error("Invalid inbox prefix", "invalid_argument", cause))
  )
  if (inboxPrefix.endsWith(".")) return yield* error("Invalid inbox prefix", "invalid_argument")
  let pool: Array<PoolServer> = initialServers.map((listen) => poolServer(listen))
  if (!options.noRandomize && pool.length > 1) {
    const shuffled = yield* Random.shuffle(pool)
    pool = Array.from(shuffled)
  }
  const statuses = yield* PubSub.unbounded<NATSOptions.Status>()
  const states = yield* SubscriptionRef.make<NATSConnection.ConnectionState>({
    state: "Connecting",
    generation: 0,
    server: pool[0].listen
  })
  const outbound = yield* Queue.make<Outbound, Error | Cause.Done>()
  const initialized = yield* Deferred.make<void, Error>()
  const closed = yield* Deferred.make<Option.Option<Error>>()
  const subscriptions = new Map<number, Subscription>()
  const requests = new Map<string, Pending>()
  const flushes = new Set<Deferred.Deferred<void, Error>>()
  let info: NATSOptions.ServerInfo | undefined
  let current: Epoch | undefined
  let nextId = 0
  let generation = 0
  let closing = false
  let draining = false
  const drainComplete = Deferred.makeUnsafe<void, Error>()
  let noMorePublishing = false
  let serverIndex = 0
  let previousAuthError: string | undefined
  let bufferedBytes = 0
  let connectedBefore = false
  let mux: Subscription | undefined
  const statistics: NATSOptions.Stats = { inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0 }
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024
  const maxPendingCommands = options.maxPendingCommands ?? 65536
  const outboundAvailable = Latch.makeUnsafe()
  const muxLock = yield* Semaphore.make(1)
  const token = () => crypto.randomUUID().replaceAll("-", "")
  const inbox = () => inboxPrefix + "." + token()
  const baseInbox = yield* NATSInbox.createInbox(inboxPrefix)
  let connection: NATSConnection.NATSConnection

  const setState = (state: NATSConnection.ConnectionState["state"], failure?: Error) =>
    SubscriptionRef.set(states, {
      state,
      generation,
      server: current?.server.listen ?? pool[serverIndex % pool.length]?.listen ?? "",
      ...(failure === undefined ? {} : { error: failure })
    })
  const finishSubscription = (sub: Subscription, failure?: NATSError.NATSSubscriptionError): void => {
    if (sub.stopped) return
    sub.stopped = true
    sub.active = false
    subscriptions.delete(sub.id)
    if (failure === undefined) Queue.endUnsafe(sub.queue)
    else Queue.failCauseUnsafe(sub.queue, Cause.fail(failure))
    complete(sub.closed, Effect.succeed(Option.fromNullishOr(failure)))
    complete(sub.first, Effect.void)
    Latch.openUnsafe(sub.empty)
  }
  const retire = (epoch: Epoch, failure: Error): void => {
    if (!epoch.active) return
    epoch.active = false
    epoch.ready = false
    if (current === epoch) current = undefined
    for (const ping of epoch.pongs) complete(ping, Effect.fail(failure))
    epoch.pongs.length = 0
    for (const ping of flushes) complete(ping, Effect.fail(failure))
    flushes.clear()
    complete(epoch.failure, Effect.fail(failure))
    Latch.openUnsafe(outboundAvailable)
  }
  const stop = (failure?: Error): Effect.Effect<void> =>
    Effect.suspend(() =>
      closing ? Effect.void : Effect.sync(() => {
        closing = true
        noMorePublishing = true
        const reason = failure ?? error("Connection closed", "closed")
        if (current !== undefined) retire(current, reason)
        for (const sub of subscriptions.values()) {
          finishSubscription(sub, failure === undefined ? undefined : subError(reason.reason, reason))
        }
        subscriptions.clear()
        for (const pending of requests.values()) {
          pending.fail(reason)
        }
        requests.clear()
        for (const ping of flushes) complete(ping, Effect.fail(reason))
        flushes.clear()
        Queue.shutdownUnsafe(outbound)
        bufferedBytes = 0
        Latch.openUnsafe(outboundAvailable)
        complete(initialized, Effect.fail(reason))
        complete(closed, Effect.succeed(Option.fromNullishOr(failure)))
      }).pipe(
        Effect.andThen(setState("Closed", failure)),
        Effect.andThen(PubSub.end(statuses, { type: "close" })),
        Effect.asVoid
      )
    )

  const enqueue = Effect.fnUntraced(function*(command: Outbound): Effect.fn.Return<void, Error> {
    while (true) {
      if (closing) return yield* error("Connection closed", "closed")
      const full = bufferedBytes + command.data.length > maxBufferedBytes ||
        Queue.sizeUnsafe(outbound) >= maxPendingCommands
      if (!full) {
        bufferedBytes += command.data.length
        Queue.offerUnsafe(outbound, command)
        return
      }
      if (
        options.maxBufferedBytes !== undefined || options.maxPendingCommands !== undefined ||
        command.data.length > maxBufferedBytes || current?.ready !== true
      ) return yield* error("Outbound buffer limit exceeded", "buffer_limit")
      Latch.closeUnsafe(outboundAvailable)
      yield* outboundAvailable.await
    }
  })
  const command = (text: string): Effect.Effect<void, Error> =>
    Effect.suspend(() => {
      const epoch = current
      if (epoch === undefined || !epoch.ready) return Effect.void
      return enqueue({ data: Protocol.encodeCommand(text), generation: epoch.generation })
    })
  const flush = Effect.suspend((): Effect.Effect<void, Error> => {
    if (closing) return Effect.fail(error("Connection closed", "closed"))
    const ping = Deferred.makeUnsafe<void, Error>()
    flushes.add(ping)
    return enqueue({ data: Protocol.encodeCommand("PING\r\n"), ping }).pipe(
      Effect.andThen(timeout(Deferred.await(ping), options.timeout ?? 20000, "Flush timed out")),
      Effect.ensuring(Effect.sync(() => {
        flushes.delete(ping)
        if (!Deferred.isDoneUnsafe(ping)) complete(ping, Effect.fail(error("Flush interrupted", "cancelled")))
      }))
    )
  })

  const publish = Effect.fnUntraced(function*(
    subject: string,
    payload: NATSOptions.Payload = empty,
    publishOptions?: NATSOptions.PublishOptions
  ) {
    if (closing) return yield* error("Connection closed", "closed")
    if (noMorePublishing) return yield* error("Connection is draining", "draining")
    yield* validateSubject(subject, true)
    if (publishOptions?.reply !== undefined) yield* validateSubject(publishOptions.reply, true)
    const bytes = typeof payload === "string" ? encoder.encode(payload) : payload
    if (!(bytes instanceof Uint8Array)) return yield* error("Invalid publish payload", "invalid_argument")
    if (
      (publishOptions?.headers !== undefined || typeof publishOptions?.traceOnly === "boolean" ||
        publishOptions?.traceDestination !== undefined) && info?.headers === false
    ) {
      return yield* error("Server does not support headers", "unsupported")
    }
    const encoded = yield* Effect.try({
      try: () => Protocol.encodePublish(subject, bytes, publishOptions),
      catch: (cause) => error("Failed to encode publication", "invalid_argument", cause, subject)
    })
    const payloadBytes = encoded.length - (encoded.indexOf(13) + 2) - 2
    if (info !== undefined && payloadBytes > info.max_payload) {
      return yield* error("Maximum payload exceeded", "max_payload", undefined, subject)
    }
    yield* enqueue({ data: encoded })
    statistics.outMsgs++
    statistics.outBytes += payloadBytes
  })
  const unsubscribe = (sub: Subscription, max?: number): Effect.Effect<void, NATSError.NATSSubscriptionError> =>
    Effect.gen(function*() {
      if (sub.stopped) {
        // A broker-generated no-responders message does not consume its
        // automatic subscription limit. Explicit cleanup still removes it.
        return yield* command("UNSUB " + sub.id + "\r\n").pipe(
          Effect.mapError((cause) => subError("Failed to unsubscribe", cause))
        )
      }
      if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
        return yield* subError("Invalid subscription maximum")
      }
      if (max !== undefined && max > sub.received) {
        sub.max = max
        yield* command("UNSUB " + sub.id + " " + (max - sub.epochReceived) + "\r\n").pipe(
          Effect.mapError((cause) => subError("Failed to unsubscribe", cause))
        )
        return
      }
      yield* command("UNSUB " + sub.id + "\r\n").pipe(
        Effect.mapError((cause) => subError("Failed to unsubscribe", cause))
      )
      finishSubscription(sub)
    })
  const subscribe = Effect.fnUntraced(function*(
    subject: string,
    subOptions: NATSOptions.SubscriptionOptions = {}
  ): Effect.fn.Return<NATSSubscription.NATSSubscription, Error> {
    if (closing) return yield* error("Connection closed", "closed")
    if (draining) return yield* error("Connection is draining", "draining")
    yield* NATSOptions.validateSubscriptionOptions(subOptions)
    yield* validateSubject(subject)
    if (subOptions.queue !== undefined) yield* validateSubject(subOptions.queue, true)
    if (subOptions.max !== undefined && (!Number.isSafeInteger(subOptions.max) || subOptions.max <= 0)) {
      return yield* error("Subscription maximum must be positive", "invalid_argument")
    }
    const queue = yield* Queue.make<Message, NATSError.NATSSubscriptionError | Cause.Done>({
      capacity: subOptions.maxPendingMessages ?? subOptions.capacity ?? Number.POSITIVE_INFINITY,
      strategy: "dropping"
    })
    const sub: Subscription = {
      id: ++nextId,
      subject,
      options: subOptions,
      queue,
      closed: Deferred.makeUnsafe(),
      empty: Latch.makeUnsafe(true),
      first: Deferred.makeUnsafe(),
      callbackDone: Deferred.makeUnsafe(),
      received: 0,
      epochReceived: 0,
      processed: 0,
      bytes: 0,
      max: subOptions.max,
      stopped: false,
      draining: false,
      active: true,
      slow: false,
      consuming: false
    }
    const drainSub = Effect.gen(function*() {
      if (closing) return yield* subError("Connection closed")
      if (sub.stopped) return yield* subError("Subscription is already closed")
      if (sub.draining) return yield* Deferred.await(sub.closed).pipe(Effect.asVoid)
      sub.draining = true
      yield* command("UNSUB " + sub.id + "\r\n").pipe(
        Effect.mapError((cause) => subError("Failed to drain subscription", cause))
      )
      yield* flush.pipe(Effect.mapError((cause) => subError("Failed to drain subscription", cause)))
      sub.active = false
      finishSubscription(sub)
      if (subOptions.callback !== undefined && (yield* CurrentCallback) !== sub) {
        yield* Deferred.await(sub.callbackDone)
      }
    })
    const handle: NATSSubscription.NATSSubscription = {
      [NATSSubscription.TypeId]: NATSSubscription.TypeId,
      stream: subOptions.callback === undefined ?
        Stream.unwrap(
          Effect.acquireRelease(
            Effect.suspend(() => {
              if (sub.consuming) return Effect.fail(subError("Subscription stream is already being consumed"))
              sub.consuming = true
              return Effect.void
            }),
            () => unsubscribe(sub).pipe(Effect.ignore)
          ).pipe(Effect.as(
            Stream.fromQueue(queue).pipe(
              Stream.mapEffect((message) =>
                Effect.sync(() => {
                  sub.processed++
                  sub.bytes -= message.data.length
                  sub.slow = false
                  if (Queue.sizeUnsafe(queue) === 0) Latch.openUnsafe(sub.empty)
                  return message
                })
              )
            )
          ))
        ) :
        Stream.fail(subError("Callback subscriptions cannot also be consumed as streams")),
      unsubscribe: (max) => unsubscribe(sub, max),
      resubscribe: (nextSubject) =>
        Effect.gen(function*() {
          if (closing) return yield* subError("Connection closed")
          if (sub.stopped || sub.draining) return yield* subError("Subscription is closed or draining")
          yield* validateSubject(nextSubject).pipe(Effect.mapError((cause) => subError("Invalid subject", cause)))
          yield* command("UNSUB " + sub.id + "\r\n").pipe(
            Effect.mapError((cause) => subError("Failed to remove subscription interest", cause))
          )
          subscriptions.delete(sub.id)
          sub.id = ++nextId
          sub.subject = nextSubject
          sub.epochReceived = 0
          subscriptions.set(sub.id, sub)
          yield* command(
            "SUB " + nextSubject + (subOptions.queue === undefined ? "" : " " + subOptions.queue) + " " + sub.id +
              "\r\n"
          ).pipe(Effect.mapError((cause) => subError("Failed to restore subscription interest", cause)))
          if (sub.max !== undefined) {
            yield* command("UNSUB " + sub.id + " " + (sub.max - sub.received) + "\r\n").pipe(
              Effect.mapError((cause) => subError("Failed to restore subscription maximum", cause))
            )
          }
        }),
      drain: drainSub,
      closed: Deferred.await(sub.closed),
      isClosed: Effect.sync(() => sub.stopped),
      isDraining: Effect.sync(() => sub.draining),
      getSubject: Effect.sync(() => sub.subject),
      getID: Effect.sync(() => sub.id),
      getReceived: Effect.sync(() => sub.received),
      getProcessed: Effect.sync(() => sub.processed),
      getPending: Effect.sync(() => sub.received - sub.processed),
      getMax: Effect.sync(() => Option.fromNullishOr(sub.max))
    }
    sub.handle = handle
    if (subOptions.callback !== undefined) {
      const invoke = Effect.fnUntraced(function*(
        failure: Option.Option<NATSError.NATSSubscriptionError>,
        value: Option.Option<Message>
      ) {
        yield* Effect.suspend(() => {
          try {
            const result = subOptions.callback?.(failure, value)
            if (Effect.isEffect(result)) return result
            if (result instanceof Promise) {
              return Effect.tryPromise({
                try: () => result,
                catch: (cause) => subError("Subscription callback failed", cause)
              })
            }
            return Effect.void
          } catch (cause) {
            return Effect.fail(subError("Subscription callback failed", cause))
          }
        })
      })
      const worker = Stream.fromQueue(queue).pipe(
        Stream.runForEach((message) =>
          invoke(Option.none(), Option.some(message)).pipe(
            Effect.provideService(CurrentCallback, sub),
            Effect.andThen(Effect.sync(() => {
              sub.processed++
              sub.bytes -= message.data.length
              sub.slow = false
              if (Queue.sizeUnsafe(queue) === 0) Latch.openUnsafe(sub.empty)
            }))
          )
        ),
        Effect.catch((cause) =>
          invoke(Option.some(cause), Option.none()).pipe(
            Effect.ensuring(Effect.sync(() => finishSubscription(sub, cause))),
            Effect.ensuring(command("UNSUB " + sub.id + "\r\n").pipe(Effect.ignore)),
            Effect.catch((callbackFailure) =>
              Effect.sync(() => {
                PubSub.publishUnsafe(statuses, { type: "error", error: callbackFailure })
              })
            )
          )
        ),
        Effect.ensuring(Deferred.succeed(sub.callbackDone, undefined))
      )
      yield* worker.pipe(Effect.forkIn(scope, { startImmediately: true }))
    }
    subscriptions.set(sub.id, sub)
    yield* command(
      "SUB " + subject + (subOptions.queue === undefined ? "" : " " + subOptions.queue) + " " + sub.id + "\r\n"
    )
    if (sub.max !== undefined) yield* command("UNSUB " + sub.id + " " + sub.max + "\r\n")
    if (subOptions.timeout !== undefined) {
      yield* timeout(Deferred.await(sub.first), subOptions.timeout, "Subscription timed out", subject).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => finishSubscription(sub, subError("Subscription timed out", cause))).pipe(
            Effect.andThen(command("UNSUB " + sub.id + "\r\n").pipe(Effect.ignore))
          )
        ),
        Effect.forkIn(scope)
      )
    }
    return handle
  })
  const noResponders = (message: Message, subject: string): Error | undefined =>
    message.data.length === 0 && Option.isSome(message.headers) && message.headers.value.code === 503
      ? error("No responders for subject", "no_responders", undefined, subject)
      : undefined
  const ensureMux = Effect.gen(function*() {
    if (mux !== undefined && !mux.stopped) return
    const handle = yield* subscribe(baseInbox + ".*", {
      callback: (failure, value) => {
        if (Option.isSome(failure)) {
          for (const pending of requests.values()) {
            if (!pending.mux) continue
            pending.fail(requestFailure("Request subscription failed", failure.value, pending.subject))
          }
          for (const [id, pending] of requests) if (pending.mux) requests.delete(id)
          return
        }
        if (Option.isNone(value)) return
        const message = value.value
        const pending = requests.get(message.subject.slice(baseInbox.length + 1))
        return pending === undefined ? Effect.void : pending.message(message)
      }
    })
    mux = subscriptions.get(yield* handle.getID)
  }).pipe(muxLock.withPermits(1))
  const request = Effect.fnUntraced(function*(
    subject: string,
    payload: NATSOptions.Payload = empty,
    requestOptions: Partial<NATSOptions.RequestOptions> = {}
  ): Effect.fn.Return<Message, Error> {
    if (closing) return yield* error("Connection closed", "closed")
    if (draining) return yield* error("Connection is draining", "draining")
    yield* validateSubject(subject, true)
    const wait = requestOptions.timeout ?? 1000
    if (!Number.isFinite(wait) || wait <= 0) return yield* error("Request timeout must be positive", "invalid_argument")
    if (requestOptions.reply !== undefined && !requestOptions.noMux) {
      return yield* error("A custom reply requires noMux", "invalid_argument")
    }
    const id = token()
    const response = Deferred.makeUnsafe<Message, Error>()
    const pending: Pending = {
      subject,
      mux: !requestOptions.noMux,
      message: (message) =>
        Effect.sync(() => {
          const failure = noResponders(message, subject)
          complete(response, failure === undefined ? Effect.succeed(message) : Effect.fail(failure))
        }),
      fail: (failure) => {
        complete(response, Effect.fail(failure))
      }
    }
    let dedicated: NATSSubscription.NATSSubscription | undefined
    if (requestOptions.noMux) {
      dedicated = yield* subscribe(requestOptions.reply ?? inbox(), {
        max: 1,
        callback: (failure, message) => {
          if (Option.isSome(failure)) pending.fail(requestFailure("Request failed", failure.value, subject))
          else if (Option.isSome(message)) return pending.message(message.value)
        }
      })
    } else yield* ensureMux
    requests.set(id, pending)
    return yield* publish(subject, payload, {
      ...requestOptions,
      reply: dedicated === undefined ? baseInbox + "." + id : yield* dedicated.getSubject
    }).pipe(
      Effect.andThen(timeout(Deferred.await(response), wait, "Request timed out", subject)),
      Effect.ensuring(
        Effect.sync(() => requests.delete(id)).pipe(
          Effect.andThen(dedicated === undefined ? Effect.void : dedicated.unsubscribe().pipe(Effect.ignore))
        )
      )
    )
  })

  const requestMany = Effect.fnUntraced(function*(
    subject: string,
    payload: NATSOptions.Payload = empty,
    requestOptions: Partial<NATSOptions.RequestManyOptions> = {}
  ): Effect.fn.Return<Stream.Stream<Message, Error>, Error> {
    if (closing) return yield* error("Connection closed", "closed")
    if (draining) return yield* error("Connection is draining", "draining")
    yield* validateSubject(subject, true)
    yield* NATSOptions.validateRequestManyOptions(requestOptions)
    const maxWait = requestOptions.maxWait ?? 1000
    const strategy = requestOptions.strategy ?? "timer"
    const maxMessages = requestOptions.maxMessages ?? -1
    if (!Number.isFinite(maxWait) || maxWait <= 0) {
      return yield* error("Request maxWait must be positive", "invalid_argument")
    }
    if (!["timer", "count", "stall", "sentinel"].includes(strategy)) {
      return yield* error("Invalid request strategy", "invalid_argument")
    }
    const queue = yield* Queue.make<Message, Error | Cause.Done>()
    const done = Deferred.makeUnsafe<void>()
    const changed = Latch.makeUnsafe()
    const id = token()
    let received = 0
    let ended = false
    let deadline = (yield* Clock.currentTimeMillis) + maxWait
    let dedicated: NATSSubscription.NATSSubscription | undefined
    const finish = (failure?: Error): void => {
      if (ended) return
      ended = true
      requests.delete(id)
      if (failure === undefined) Queue.endUnsafe(queue)
      else Queue.failCauseUnsafe(queue, Cause.fail(failure))
      complete(done, Effect.void)
      Latch.openUnsafe(changed)
    }
    const receive = Effect.fnUntraced(function*(message: Message) {
      if (ended) return
      const failure = noResponders(message, subject)
      if (failure !== undefined) {
        finish(failure)
        return
      }
      Queue.offerUnsafe(queue, message)
      received++
      if (strategy === "count" && maxMessages > 0 && received >= maxMessages) {
        finish()
      } else if (strategy === "sentinel" && message.data.length === 0) finish()
      else if (strategy === "stall") {
        deadline = (yield* Clock.currentTimeMillis) + (requestOptions.stall ?? 300)
        Latch.openUnsafe(changed)
      }
    })
    if (requestOptions.noMux) {
      dedicated = yield* subscribe(inbox(), {
        callback: (failure, value) => {
          if (Option.isSome(failure)) {
            finish(requestFailure("Request failed", failure.value, subject))
            return
          }
          return Option.isSome(value) ? receive(value.value) : Effect.void
        }
      })
    } else yield* ensureMux
    requests.set(id, { subject, mux: !requestOptions.noMux, message: receive, fail: finish })
    const timer = yield* Effect.gen(function*() {
      while (true) {
        if (ended) break
        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) {
          finish()
          break
        }
        Latch.closeUnsafe(changed)
        const notified = yield* changed.await.pipe(Effect.timeoutOption(remaining))
        if (Option.isNone(notified)) finish()
      }
    }).pipe(Effect.forkIn(scope))
    const cleanup = Effect.gen(function*() {
      finish()
      yield* Fiber.interrupt(timer)
      if (dedicated !== undefined) yield* dedicated.unsubscribe().pipe(Effect.ignore)
    })
    yield* publish(subject, payload, {
      ...requestOptions,
      reply: dedicated === undefined ? baseInbox + "." + id : yield* dedicated.getSubject
    }).pipe(Effect.onError(() => cleanup))
    yield* Deferred.await(done).pipe(
      Effect.andThen(dedicated === undefined ? Effect.void : dedicated.unsubscribe().pipe(Effect.ignore)),
      Effect.forkIn(scope)
    )
    return Stream.fromQueue(queue).pipe(Stream.ensuring(cleanup))
  })

  const dispatch = Effect.fnUntraced(function*(epoch: Epoch, frame: Protocol.Frame): Effect.fn.Return<void, Error> {
    if (options.debug) {
      yield* Effect.logDebug("NATS receive", {
        server: new URL(epoch.server.listen).host,
        operation: frame._tag,
        ...(frame._tag === "Message" ? { bytes: frame.wireBytes } : {})
      })
    }
    switch (frame._tag) {
      case "Info": {
        const merged = yield* Schema.decodeUnknownEffect(NATSOptions.ServerInfo)({ ...info, ...frame.info }).pipe(
          Effect.mapError((cause) => error("Invalid server INFO", "protocol_error", cause))
        )
        info = merged
        complete(epoch.info, Effect.succeed(merged))
        if (merged.ldm) yield* PubSub.publish(statuses, { type: "ldm", server: epoch.server.listen })
        if (!options.ignoreClusterUpdates) {
          const addresses = epoch.server.listen.startsWith("ws") ? merged.ws_connect_urls : merged.connect_urls
          if (addresses !== undefined) {
            const existing = new Set(pool.map((s) => s.listen))
            const added: Array<string> = []
            const discovered = new Set<string>()
            for (const address of addresses) {
              const normalized = yield* Effect.try({
                try: () =>
                  normalizeServer(
                    address.includes("://") ? address : new URL(epoch.server.listen).protocol + "//" + address
                  ),
                catch: (cause) => error("Invalid discovered server", "protocol_error", cause)
              })
              discovered.add(normalized)
              if (!existing.has(normalized)) {
                pool.push({ ...poolServer(normalized, true), tlsName: epoch.server.tlsName })
                existing.add(normalized)
                added.push(normalized)
              }
            }
            const deleted = pool.filter((server) => server.gossiped && !discovered.has(server.listen)).map((s) =>
              s.listen
            )
            pool = pool.filter((server) => !server.gossiped || discovered.has(server.listen))
            if (!options.noRandomize && added.length > 0) {
              const others = yield* Random.shuffle(pool.filter((server) => server !== epoch.server))
              pool = pool.includes(epoch.server) ? [epoch.server, ...others] : others
            }
            serverIndex = Math.max(0, pool.indexOf(epoch.server))
            if (added.length > 0 || deleted.length > 0) {
              yield* PubSub.publish(statuses, { type: "update", added, deleted })
            }
          }
        }
        return
      }
      case "Ping":
        yield* epoch.writer.write(Protocol.encodeCommand("PONG\r\n")).pipe(
          Effect.mapError((cause) => error("Failed to send PONG", "connection_error", cause))
        )
        return
      case "Pong": {
        const deferred = epoch.pongs.shift()
        if (deferred !== undefined) {
          flushes.delete(deferred)
          complete(deferred, Effect.void)
        }
        epoch.heartbeatPings = 0
        return
      }
      case "Ok":
        return
      case "Error": {
        const text = frame.message
        const denied = /permissions violation for subscription to ["']?([^"'\s]+)["']?/i.exec(text)
        const deniedPublish = /permissions violation for publish to ["']([^"']+)["']/i.exec(text)
        const deniedQueue = /using queue ["']([^"']+)["']/i.exec(text)
        const deniedSid = /using sid (\d+)/i.exec(text)
        const failure = error(
          text,
          denied !== null || deniedPublish !== null ?
            "permissions" :
            /authorization|authentication|user authentication/i.test(text)
            ? "authorization"
            : "server_error",
          undefined,
          denied?.[1] ?? deniedPublish?.[1]
        )
        yield* PubSub.publish(statuses, { type: "error", error: failure })
        if (denied) {
          for (const sub of subscriptions.values()) {
            if (
              deniedSid !== null ?
                sub.id === Number(deniedSid[1]) :
                sub.subject === denied[1] && sub.options.queue === deniedQueue?.[1]
            ) {
              finishSubscription(sub, subError(text, failure))
            }
          }
          return
        }
        if (deniedPublish) {
          for (const [id, pending] of requests) {
            if (pending.subject === deniedPublish[1]) {
              pending.fail(failure)
              requests.delete(id)
            }
          }
          return
        }
        return yield* failure
      }
      case "Message": {
        statistics.inMsgs++
        statistics.inBytes += frame.wireBytes
        const sub = subscriptions.get(frame.sid)
        if (sub === undefined || !sub.active || sub.stopped) return
        sub.received++
        complete(sub.first, Effect.void)
        const message = NATSMessage.make(frame, publish)
        if (
          sub.options.maxPendingBytes !== undefined && sub.bytes + message.data.length > sub.options.maxPendingBytes
        ) {
          finishSubscription(sub, subError("Subscription pending byte limit exceeded"))
          yield* command("UNSUB " + sub.id + "\r\n")
        } else if (!Queue.offerUnsafe(sub.queue, message)) {
          finishSubscription(sub, subError("Subscription pending message limit exceeded"))
          yield* command("UNSUB " + sub.id + "\r\n")
        } else {
          sub.bytes += message.data.length
          Latch.closeUnsafe(sub.empty)
          const pending = Queue.sizeUnsafe(sub.queue)
          if (sub.options.slow !== undefined && pending > sub.options.slow && !sub.slow && sub.handle !== undefined) {
            sub.slow = true
            yield* PubSub.publish(statuses, { type: "slowConsumer", sub: sub.handle, pending })
          }
          if (sub.options.callback !== undefined) yield* Effect.yieldNow
        }
        if (sub.max !== undefined && sub.received >= sub.max) finishSubscription(sub)
      }
    }
  })

  const session = Effect.gen(function*() {
    if (closing) return
    if (connectedBefore) {
      const discarded = yield* Queue.clear(outbound)
      bufferedBytes -= discarded.reduce((bytes, item) => bytes + item.data.length, 0)
      for (const item of discarded) {
        if (item.ping !== undefined) complete(item.ping, Effect.fail(error("Connection disconnected", "disconnected")))
      }
      Latch.openUnsafe(outboundAvailable)
    }
    let selected = pool[serverIndex % pool.length]
    if (selected === undefined) return yield* error("Server pool exhausted", "connection_error")
    const selectServer = options.reconnectToServer
    if (selectServer !== undefined) {
      const picked = yield* Effect.try({
        try: () => selectServer(pool.map((server) => ({ ...server })), Option.fromNullishOr(info)),
        catch: (cause) => error("Reconnect server handler failed", "reconnect_handler", cause)
      })
      if (Option.isSome(picked)) {
        const target = "server" in picked.value ? picked.value.server : picked.value
        const found = pool.find((server) => server.listen === target.listen)
        if (found === undefined) {
          return yield* error("Selected reconnect server is not in the pool", "reconnect_handler")
        }
        selected = found
        serverIndex = pool.indexOf(found)
        if ("server" in picked.value && Number.isFinite(picked.value.delay) && picked.value.delay > 0) {
          yield* Effect.sleep(Math.floor(picked.value.delay))
        }
      }
    }
    generation++
    selected.lastConnect = yield* Clock.currentTimeMillis
    info = undefined
    yield* setState(connectedBefore ? "Reconnecting" : "Connecting")
    if (connectedBefore) yield* PubSub.publish(statuses, { type: "reconnecting" })
    let sessionEpoch: Epoch | undefined
    let established = false
    return yield* Effect.scoped(Effect.gen(function*() {
      const socket = yield* socketFactory(selected.listen, { ...selected }).pipe(
        Effect.mapError((cause) => error("Transport construction failed", "connection_error", cause))
      )
      const reader = yield* timeout(socket.reader, options.timeout ?? 20000, "Connection timed out").pipe(
        Effect.mapError((cause) =>
          cause instanceof NATSError.NATSConnectionError ? cause : error("Connection failed", "connection_error", cause)
        )
      )
      const transportWriter = yield* socket.writer
      const debugWrite = (chunk: Uint8Array | string | Socket.CloseEvent) => {
        const text = typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
          ? new TextDecoder().decode(chunk.subarray(0, 16))
          : "CLOSE"
        return Effect.logDebug("NATS send", {
          server: new URL(selected.listen).host,
          operation: text.split(/\s/, 1)[0],
          bytes: typeof chunk === "string"
            ? encoder.encode(chunk).length
            : chunk instanceof Uint8Array
            ? chunk.length
            : 0
        })
      }
      const writer: Socket.Writer = !options.debug ? transportWriter : {
        write: (chunk) => transportWriter.write(chunk).pipe(Effect.andThen(debugWrite(chunk))),
        writeAll: (chunks) =>
          transportWriter.writeAll(chunks).pipe(
            Effect.andThen(Effect.forEach(chunks, debugWrite, { discard: true }))
          )
      }
      const epoch: Epoch = {
        generation,
        server: selected,
        writer,
        failure: Deferred.makeUnsafe(),
        pongs: [],
        info: Deferred.makeUnsafe(),
        active: true,
        ready: false,
        heartbeatPings: 0
      }
      current = epoch
      sessionEpoch = epoch
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => retire(epoch, error("Physical connection retired", "disconnected")))
      )
      const parser = new Protocol.Parser({
        maxControlLine: options.maxControlLine ?? 4096,
        maxPayload: maxBufferedBytes
      })
      // INFO is plaintext on traditional TLS endpoints. Do not pull encrypted
      // bytes through the plaintext parser before upgrading the reader.
      while (!Deferred.isDoneUnsafe(epoch.info)) {
        const chunks = yield* timeout(reader.pull, options.timeout ?? 20000, "Server INFO timed out").pipe(
          Effect.mapError((cause) =>
            cause instanceof NATSError.NATSConnectionError
              ? cause
              : error("Server INFO failed", "connection_error", cause)
          )
        )
        for (const chunk of chunks) {
          const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
          const frames = yield* Effect.try({
            try: () => parser.feed(bytes),
            catch: (cause) => error("Invalid NATS protocol", "protocol_error", cause)
          })
          for (const frame of frames) yield* dispatch(epoch, frame)
        }
      }
      const serverInfo = yield* Deferred.await(epoch.info)
      const tlsFirst = typeof options.tls === "object" && options.tls.handshakeFirst === true
      const ws = selected.listen.startsWith("ws")
      if (!ws && options.tls === false && (serverInfo.tls_required || selected.listen.startsWith("tls:"))) {
        return yield* error("Server requires TLS but TLS is disabled", "tls_error")
      }
      if (
        !ws && !tlsFirst && typeof options.tls === "object" && !serverInfo.tls_required && !serverInfo.tls_available
      ) {
        return yield* error("Server does not support TLS", "tls_error")
      }
      if (
        !ws && !tlsFirst &&
        (serverInfo.tls_required || (serverInfo.tls_available && options.tls !== false) ||
          selected.listen.startsWith("tls:") || typeof options.tls === "object")
      ) {
        yield* timeout(reader.upgrade(), options.timeout ?? 20000, "TLS handshake timed out").pipe(
          Effect.mapError((cause) =>
            cause instanceof NATSError.NATSConnectionError ? cause : error("TLS handshake failed", "tls_error", cause)
          )
        )
      }
      if (options.noEcho && serverInfo.proto < 1) return yield* error("Server does not support noEcho", "unsupported")
      const auth = yield* NATSAuth.buildAuthenticator(options)(serverInfo.nonce).pipe(
        Effect.mapError((cause) => error("Authentication failed", "authorization", cause))
      )
      const url = new URL(selected.listen)
      if (options.token !== undefined) auth.auth_token = options.token
      if (options.user !== undefined) {
        auth.user = options.user
        auth.pass = options.pass ?? ""
      } else if (url.username !== "") {
        if (url.password !== "") {
          auth.user = decodeURIComponent(url.username)
          auth.pass = decodeURIComponent(url.password)
        } else auth.auth_token = decodeURIComponent(url.username)
      }
      const connect = {
        verbose: options.verbose ?? false,
        pedantic: options.pedantic ?? false,
        tls_required: serverInfo.tls_required === true || typeof options.tls === "object" ||
          selected.listen.startsWith("tls:"),
        name: options.name,
        lang: "typescript-effect",
        version: "1.0.0-beta.0",
        protocol: 1,
        echo: !options.noEcho,
        headers: serverInfo.headers ?? false,
        no_responders: serverInfo.headers ?? false,
        ...auth
      }
      yield* writer.write(Protocol.encodeCommand("CONNECT " + JSON.stringify(connect) + "\r\n")).pipe(
        Effect.mapError((cause) => error("CONNECT write failed", "connection_error", cause))
      )
      const readerLoop = Effect.gen(function*() {
        while (epoch.active) {
          const chunks = yield* reader.pull.pipe(
            Effect.mapError((cause) =>
              error(
                cause.reason._tag === "SocketCloseError" && cause.reason.code === 1000
                  ? "Server closed connection"
                  : "Socket read failed",
                cause.reason._tag === "SocketCloseError" && cause.reason.code === 1000
                  ? "server_closed"
                  : "connection_error",
                cause
              )
            )
          )
          for (const chunk of chunks) {
            const frames = yield* Effect.try({
              try: () => parser.feed(typeof chunk === "string" ? encoder.encode(chunk) : chunk),
              catch: (cause) => error("Invalid NATS protocol", "protocol_error", cause)
            })
            for (const frame of frames) yield* dispatch(epoch, frame)
          }
        }
      }).pipe(Effect.catch((failure) => Effect.sync(() => retire(epoch, failure))))
      yield* readerLoop.pipe(Effect.forkScoped)
      const handshake = Deferred.makeUnsafe<void, Error>()
      epoch.pongs.push(handshake)
      yield* writer.write(Protocol.encodeCommand("PING\r\n")).pipe(
        Effect.mapError((cause) => error("Handshake write failed", "connection_error", cause))
      )
      yield* timeout(Deferred.await(handshake), options.timeout ?? 20000, "CONNECT handshake timed out")
      for (const sub of subscriptions.values()) {
        if (!sub.active || sub.stopped) continue
        sub.epochReceived = sub.received
        yield* writer.write(Protocol.encodeCommand(
          "SUB " + sub.subject + (sub.options.queue === undefined ? "" : " " + sub.options.queue) + " " + sub.id +
            "\r\n"
        )).pipe(Effect.mapError((cause) => error("Subscription recovery failed", "connection_error", cause)))
        if (sub.max !== undefined) {
          yield* writer.write(Protocol.encodeCommand(
            "UNSUB " + sub.id + " " + (sub.max - sub.received) + "\r\n"
          )).pipe(Effect.mapError((cause) => error("Subscription recovery failed", "connection_error", cause)))
        }
      }
      epoch.ready = true
      selected.didConnect = true
      selected.lastConnect = yield* Clock.currentTimeMillis
      selected.reconnects = 0
      established = true
      previousAuthError = undefined
      yield* setState(draining ? "Draining" : "Connected")
      if (connectedBefore) yield* PubSub.publish(statuses, { type: "reconnect", server: selected.listen })
      connectedBefore = true
      complete(initialized, Effect.void)
      const writerLoop = Effect.gen(function*() {
        while (epoch.active) {
          const item = yield* Queue.take(outbound).pipe(
            Effect.mapError((cause) => error("Outbound queue closed", "closed", cause))
          )
          bufferedBytes -= item.data.length
          Latch.openUnsafe(outboundAvailable)
          if (item.generation !== undefined && item.generation !== epoch.generation) continue
          if (item.ping !== undefined) {
            if (Deferred.isDoneUnsafe(item.ping)) continue
            epoch.pongs.push(item.ping)
          }
          yield* writer.write(item.data).pipe(
            Effect.mapError((cause) => error("Socket write failed", "connection_error", cause))
          )
        }
      }).pipe(Effect.catch((failure) => Effect.sync(() => retire(epoch, failure))))
      yield* writerLoop.pipe(Effect.forkScoped)
      const heartbeat = Effect.suspend((): Effect.Effect<void, Error> => {
        if (!epoch.active || closing) return Effect.void
        epoch.heartbeatPings++
        if (epoch.heartbeatPings > (options.maxPingOut ?? 2)) {
          PubSub.publishUnsafe(statuses, { type: "staleConnection" })
          const failure = error("Stale connection", "stale_connection")
          retire(epoch, failure)
          return Effect.fail(failure)
        }
        PubSub.publishUnsafe(statuses, { type: "ping", pendingPings: epoch.heartbeatPings })
        return enqueue({
          data: Protocol.encodeCommand("PING\r\n"),
          generation: epoch.generation,
          ping: Deferred.makeUnsafe()
        })
      }).pipe(
        Effect.repeat(Schedule.spaced(options.pingInterval ?? 120000)),
        Effect.delay(options.pingInterval ?? 120000),
        Effect.catch((failure) => Effect.sync(() => retire(epoch, failure)))
      )
      yield* heartbeat.pipe(Effect.forkScoped)
      return yield* Deferred.await(epoch.failure)
    })).pipe(Effect.catch((failure) =>
      Effect.gen(function*() {
        if (sessionEpoch !== undefined) retire(sessionEpoch, failure)
        if (!established) selected.reconnects++
        if (failure.code === "authorization") {
          if (previousAuthError === failure.reason && !options.ignoreAuthErrorAbort) {
            return yield* error(failure.reason, "authorization_permanent", failure)
          }
          previousAuthError = failure.reason
        }
        if (closing) return
        if (established) yield* PubSub.publish(statuses, { type: "disconnect", server: selected.listen })
        yield* setState("Reconnecting", failure)
        const maximum = options.maxReconnectAttempts ?? 10
        const index = pool.indexOf(selected)
        if ((!connectedBefore && !options.waitOnFirstConnect) || (maximum >= 0 && selected.reconnects >= maximum)) {
          if (index >= 0) pool.splice(index, 1)
          serverIndex = pool.length === 0 ? 0 : Math.max(0, index) % pool.length
        } else serverIndex = (Math.max(0, index) + 1) % pool.length
        return yield* failure
      })
    ))
  })
  const retrySchedule = Schedule.spaced(options.reconnectTimeWait ?? 2000).pipe(
    Schedule.setInputType<Error>(),
    Schedule.while(({ input }) => {
      if (
        closing || pool.length === 0 || input.code === "protocol_error" || input.code === "authorization_permanent" ||
        input.code === "reconnect_handler"
      ) return false
      return !connectedBefore || options.reconnect !== false
    }),
    Schedule.modifyDelay(() =>
      Effect.gen(function*() {
        if (!connectedBefore && !options.waitOnFirstConnect) return 0
        if (options.reconnectDelayHandler !== undefined) {
          return yield* Effect.try({
            try: options.reconnectDelayHandler,
            catch: (cause) => error("Reconnect delay handler failed", "invalid_argument", cause)
          })
        }
        const jitter = options.tls ? options.reconnectJitterTLS ?? 1000 : options.reconnectJitter ?? 100
        const extra = yield* Random.nextIntBetween(0, Math.floor(jitter))
        return (options.reconnectTimeWait ?? 2000) + extra
      })
    )
  )
  const supervisor = yield* session.pipe(
    Effect.retry(retrySchedule),
    Effect.catch((failure) =>
      failure.code === "server_closed" && connectedBefore && options.reconnect === false ? stop() : stop(failure)
    ),
    Effect.forkIn(scope)
  )
  const close = stop().pipe(Effect.andThen(Fiber.interrupt(supervisor)), Effect.asVoid)
  const drain = Effect.gen(function*() {
    if (closing) return yield* error("Connection closed", "closed")
    if (draining) return yield* error("Connection is draining", "draining")
    draining = true
    yield* Effect.gen(function*() {
      yield* setState("Draining")
      yield* Effect.forEach(
        Array.from(subscriptions.values()).filter((sub) => sub !== mux),
        (sub) =>
          (sub.handle?.drain ?? Effect.void).pipe(
            Effect.mapError((cause) => error("Subscription drain failed", "drain_error", cause))
          ),
        { concurrency: "unbounded", discard: true }
      )
      noMorePublishing = true
      yield* flush
      yield* close
    }).pipe(
      Effect.onError(() => close),
      Effect.onExit((exit) => Deferred.done(drainComplete, exit))
    )
  })
  const reconnect = Effect.gen(function*() {
    if (closing) return yield* error("Connection closed", "closed")
    if (draining) return yield* error("Connection is draining", "draining")
    const epoch = current
    if (epoch === undefined) return
    yield* PubSub.publish(statuses, { type: "forceReconnect" })
    retire(epoch, error("Forced reconnection", "disconnected"))
    yield* states.pipe(
      SubscriptionRef.changes,
      Stream.filter((s) => s.generation > epoch.generation && (s.state === "Connected" || s.state === "Closed")),
      Stream.runHead
    )
  })
  connection = {
    [Services.ConnectionTypeId]: Services.ConnectionTypeId,
    get info() {
      return closing ? Option.none() : Option.fromNullishOr(info)
    },
    publish,
    publishMessage: (message) =>
      publish(message.subject, message.data, {
        ...Option.match(message.reply, { onNone: () => ({}), onSome: (reply) => ({ reply }) }),
        ...Option.match(message.headers, { onNone: () => ({}), onSome: (headers) => ({ headers }) })
      }),
    respondMessage: (message) =>
      Option.match(message.reply, {
        onNone: () => Effect.succeed(false),
        onSome: (reply) =>
          publish(reply, message.data, {
            reply,
            ...Option.match(message.headers, { onNone: () => ({}), onSome: (headers) => ({ headers }) })
          }).pipe(Effect.as(true))
      }),
    subscribe,
    request,
    requestMany,
    createInbox: Effect.sync(inbox),
    flush,
    drain,
    close,
    closed: Deferred.await(closed),
    isClosed: Effect.sync(() => closing),
    isDraining: Effect.sync(() => draining),
    getServer: Effect.sync(() => current?.server.listen ?? ""),
    getServers: Effect.sync(() => pool.map((s) => ({ ...s }))),
    setServers: (servers) =>
      Effect.gen(function*() {
        const normalized = yield* Effect.try({
          try: () => {
            if (!Array.isArray(servers) || servers.length === 0) {
              throw new globalThis.Error("Server pool cannot be empty")
            }
            return [...new Set(servers.map(normalizeServer))]
          },
          catch: (cause) => error("Invalid server pool", "invalid_argument", cause)
        })
        const replacements = normalized.map((listen) => {
          const surviving = pool.find((server) => server.listen === listen)
          if (surviving === undefined) return poolServer(listen)
          surviving.gossiped = false
          return surviving
        })
        pool = options.noRandomize ? replacements : yield* Random.shuffle(replacements)
        serverIndex = current === undefined ? 0 : Math.max(0, pool.indexOf(current.server))
      }),
    reconnect,
    status: Effect.succeed(Stream.fromPubSub(statuses).pipe(Stream.takeUntil((status) => status.type === "close"))),
    state: SubscriptionRef.get(states),
    changes: SubscriptionRef.changes(states),
    stats: Effect.sync(() => ({ ...statistics })),
    rtt: Effect.gen(function*() {
      if (closing) return yield* error("Connection closed", "closed")
      if (current === undefined || !current.ready) return yield* error("Connection disconnected", "disconnected")
      const start = yield* Clock.currentTimeMillis
      yield* flush
      return (yield* Clock.currentTimeMillis) - start
    })
  }
  yield* Effect.addFinalizer(() =>
    timeout(
      closing ? Effect.void : draining ? Deferred.await(drainComplete) : drain,
      options.drainTimeout ?? 30000,
      "Connection drain timed out"
    ).pipe(
      Effect.catch(() => close),
      Effect.asVoid
    )
  )
  yield* Deferred.await(initialized)
  return connection
})
