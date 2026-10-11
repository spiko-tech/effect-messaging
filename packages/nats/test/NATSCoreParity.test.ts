import { describe, expect, it } from "@effect/vitest"
import { headers as officialHeaders } from "@nats-io/nats-core"
import { connect as officialConnect } from "@nats-io/transport-node"
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import { headers } from "../src/NATSHeaders.ts"
import { testConnection } from "./dependencies.ts"

const subject = (name: string) => `native.parity.${name}`
const official = Effect.acquireRelease(
  Effect.tryPromise({ try: () => officialConnect({ servers: "localhost:4222" }), catch: (cause) => cause }),
  (connection) => Effect.promise(() => connection.close())
)

describe("Core NATS 3.4.0 behavioral parity", () => {
  it.live("interoperates with the official publisher for binary payloads and repeated headers", () =>
    Effect.gen(function*() {
      const native = yield* NATSConnection.NATSConnection
      const reference = yield* official
      const subscription = yield* native.subscribe(subject("official.publish"), { max: 1 })
      yield* native.flush
      const payload = Uint8Array.of(0, 13, 10, 255, 128, 0)
      const referenceHeaders = officialHeaders()
      referenceHeaders.append("X-Test", "first")
      referenceHeaders.append("X-Test", "second")
      reference.publish(subject("official.publish"), payload, { headers: referenceHeaders })
      yield* Effect.promise(() => reference.flush())
      const messages = yield* Stream.runCollect(subscription.stream)
      expect(messages).toHaveLength(1)
      expect(messages[0].data).toEqual(payload)
      expect(Option.getOrThrow(messages[0].headers).values("X-Test")).toEqual(["first", "second"])
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("interoperates with the official subscriber for native headers and reply subjects", () =>
    Effect.gen(function*() {
      const native = yield* NATSConnection.NATSConnection
      const reference = yield* official
      const subscription = reference.subscribe(subject("native.publish"), { max: 1 })
      yield* Effect.promise(() => reference.flush())
      const nativeHeaders = headers()
      nativeHeaders.append("X-Test", "first")
      nativeHeaders.append("X-Test", "second")
      yield* native.publish(subject("native.publish"), Uint8Array.of(0, 255, 10), {
        reply: subject("reply"),
        headers: nativeHeaders
      })
      yield* native.flush
      const messages = yield* Effect.promise(async () => {
        const result = []
        for await (const message of subscription) result.push(message)
        return result
      })
      expect(messages).toHaveLength(1)
      expect(Array.from(messages[0].data)).toEqual([0, 255, 10])
      expect(messages[0].reply).toBe(subject("reply"))
      expect(messages[0].headers?.values("X-Test")).toEqual(["first", "second"])
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("automatic unsubscribe preserves all accepted messages and closes at its maximum", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("max"), { max: 3 })
      for (const value of ["one", "two", "three", "ignored"]) yield* connection.publish(subject("max"), value)
      yield* connection.flush
      const received = yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)
      expect(received).toEqual(["one", "two", "three"])
      expect(yield* subscription.isClosed).toBe(true)
      expect(yield* subscription.getReceived).toBe(3)
      expect(yield* subscription.getProcessed).toBe(3)
      expect(yield* subscription.getMax).toEqual(Option.some(3))
    }).pipe(Effect.provide(testConnection)))

  it.live("queue groups deliver each publication once while ordinary subscriptions receive every publication", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const first = yield* connection.subscribe(subject("queue"), { queue: "workers" })
      const second = yield* connection.subscribe(subject("queue"), { queue: "workers" })
      const observer = yield* connection.subscribe(subject("queue"), { max: 40 })
      yield* connection.flush
      for (let index = 0; index < 40; index++) yield* connection.publish(subject("queue"), `${index}`)
      yield* connection.flush
      const deliveries = yield* Stream.merge(first.stream, second.stream).pipe(
        Stream.take(40),
        Stream.mapEffect((message) => message.string),
        Stream.runCollect
      )
      const observed = yield* observer.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)
      expect(new Set(deliveries).size).toBe(40)
      expect(new Set(deliveries)).toEqual(new Set(observed))
    }).pipe(Effect.provide(testConnection)))

  it.live.each([false, true])(
    "request/reply interoperates with official responders, noMux=%s",
    (noMux) =>
      Effect.gen(function*() {
        const native = yield* NATSConnection.NATSConnection
        const reference = yield* official
        reference.subscribe(subject(`request.${noMux}`), {
          callback: (_error, message) => {
            message.respond(`echo:${message.string()}`)
          }
        })
        yield* Effect.promise(() => reference.flush())
        const response = yield* native.request(subject(`request.${noMux}`), "hello", { noMux, timeout: 1000 })
        expect(yield* response.string).toBe("echo:hello")
      }).pipe(Effect.scoped, Effect.provide(testConnection))
  )

  it.live("no responders fails with a typed connection error rather than waiting for request timeout", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const error = yield* connection.request(subject("missing"), "hello", { timeout: 1000 }).pipe(Effect.flip)
      expect(error._tag).toBe("NATSConnectionError")
      expect(error.reason.toLowerCase()).toMatch(/respond|503/)
      yield* connection.flush
    }).pipe(Effect.provide(testConnection)))

  it.live("a silent responder times out and leaves the connection usable", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const silent = yield* connection.subscribe(subject("silent"))
      yield* connection.flush
      const error = yield* connection.request(subject("silent"), "hello", { timeout: 25 }).pipe(Effect.flip)
      expect(error._tag).toBe("NATSConnectionError")
      expect(error.reason.toLowerCase()).toMatch(/timeout|timed out/)
      yield* silent.unsubscribe()
      yield* connection.flush
    }).pipe(Effect.provide(testConnection)))

  it.live("interrupting a pending request permits a subsequent request to finish", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const received = yield* Deferred.make<void>()
      const subscription = yield* connection.subscribe(subject("cancel"))
      yield* subscription.stream.pipe(
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(received, undefined)),
        Effect.forkChild
      )
      const request = yield* connection.request(subject("cancel"), "cancel me", { timeout: 60_000 }).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(received)
      yield* Fiber.interrupt(request)
      const responder = yield* connection.subscribe(subject("after.cancel"), { max: 1 })
      yield* responder.stream.pipe(
        Stream.runForEach((message) => message.respond("still alive")),
        Effect.forkChild
      )
      const response = yield* connection.request(subject("after.cancel"), "hello", { timeout: 1000 })
      expect(yield* response.string).toBe("still alive")
    }).pipe(Effect.provide(testConnection)))

  it.live.each([false, true])(
    "requestMany count ends after all expected replies, noMux=%s",
    (noMux) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe(subject(`many.count.${noMux}`), { max: 1 })
        yield* subscription.stream.pipe(
          Stream.runForEach((message) => Effect.forEach(["one", "two", "three"], (value) => message.respond(value))),
          Effect.forkChild
        )
        const responses = yield* connection.requestMany(subject(`many.count.${noMux}`), "hello", {
          strategy: "count",
          maxMessages: 3,
          maxWait: 1000,
          noMux
        })
        expect(yield* responses.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
          .toEqual(["one", "two", "three"])
      }).pipe(Effect.provide(testConnection))
  )

  it.live.each([false, true])(
    "requestMany sentinel ends on an empty reply, noMux=%s",
    (noMux) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe(subject(`many.sentinel.${noMux}`), { max: 1 })
        yield* subscription.stream.pipe(
          Stream.runForEach((message) => Effect.forEach(["one", "two", ""], (value) => message.respond(value))),
          Effect.forkChild
        )
        const responses = yield* connection.requestMany(subject(`many.sentinel.${noMux}`), "hello", {
          strategy: "sentinel",
          maxWait: 1000,
          noMux
        })
        expect(yield* responses.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
          .toEqual(["one", "two", ""])
      }).pipe(Effect.provide(testConnection))
  )

  it.live("flush establishes a broker processing barrier and updates payload statistics", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("stats"), { max: 1 })
      const before = yield* connection.stats
      yield* connection.publish(subject("stats"), "hello")
      yield* connection.flush
      yield* Stream.runCollect(subscription.stream)
      const after = yield* connection.stats
      expect(after.outMsgs - before.outMsgs).toBe(1)
      expect(after.inMsgs - before.inMsgs).toBe(1)
      expect(after.outBytes - before.outBytes).toBe(5)
      expect(after.inBytes - before.inBytes).toBe(5)
      expect(yield* connection.rtt).toBeGreaterThanOrEqual(0)
    }).pipe(Effect.provide(testConnection)))

  it.live("explicit close is idempotent and rejects subsequent publications", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.close
      yield* connection.close
      expect(yield* connection.isClosed).toBe(true)
      const error = yield* connection.publish(subject("closed"), "hello").pipe(Effect.flip)
      expect(error._tag).toBe("NATSConnectionError")
    }).pipe(Effect.provide(testConnection)))

  it.live.each(["", "bad subject", "bad\nsubject"])(
    "rejects invalid subjects %j before writing to the socket",
    (invalid) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const publishError = yield* connection.publish(invalid, "hello").pipe(Effect.flip)
        expect(publishError._tag).toBe("NATSConnectionError")
        const subscribeError = yield* connection.subscribe(invalid).pipe(Effect.flip)
        expect(subscribeError._tag).toBe("NATSConnectionError")
        yield* connection.flush
      }).pipe(Effect.provide(testConnection))
  )

  it.live("rejects payloads above the advertised server limit without closing the connection", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const limit = Option.getOrThrow(connection.info).max_payload
      const error = yield* connection.publish(subject("oversized"), new Uint8Array(limit + 1)).pipe(Effect.flip)
      expect(error._tag).toBe("NATSConnectionError")
      yield* connection.flush
    }).pipe(Effect.provide(testConnection)))

  it.live("unsubscribe with a maximum updates the subscription's lifetime count", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("unsub.max"))
      yield* subscription.unsubscribe(2)
      for (const payload of ["first", "second", "third"]) yield* connection.publish(subject("unsub.max"), payload)
      yield* connection.flush
      const received = yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)
      expect(received).toEqual(["first", "second"])
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("stopping stream consumption unsubscribes its server-side subscription", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("stream.stop"))
      yield* connection.publish(subject("stream.stop"), "first")
      yield* subscription.stream.pipe(Stream.take(1), Stream.runDrain)
      yield* connection.flush
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("subscription draining processes all admitted messages before completing", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("sub.drain"))
      const messages = yield* subscription.stream.pipe(
        Stream.mapEffect((message) => message.string),
        Stream.runCollect,
        Effect.forkChild
      )
      for (const payload of ["first", "second", "third"]) yield* connection.publish(subject("sub.drain"), payload)
      yield* connection.flush
      yield* subscription.drain
      expect(yield* Fiber.join(messages)).toEqual(["first", "second", "third"])
      expect(yield* subscription.isClosed).toBe(true)
    }).pipe(Effect.provide(testConnection)))

  it.live("connection drain finishes active subscriptions and closes cleanly", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("conn.drain"))
      const messages = yield* subscription.stream.pipe(
        Stream.mapEffect((message) => message.string),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* connection.publish(subject("conn.drain"), "accepted")
      yield* connection.drain
      expect(yield* Fiber.join(messages)).toEqual(["accepted"])
      expect(yield* connection.isClosed).toBe(true)
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.provide(testConnection)))

  it.live.each([false, true])(
    "requestMany timer finishes with no replies from a silent subscriber, noMux=%s",
    (noMux) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const silent = yield* connection.subscribe(subject(`many.timer.${noMux}`))
        const replies = yield* connection.requestMany(subject(`many.timer.${noMux}`), "hello", {
          strategy: "timer",
          maxWait: 25,
          noMux
        })
        expect(yield* Stream.runCollect(replies)).toEqual([])
        yield* silent.unsubscribe()
        yield* connection.flush
      }).pipe(Effect.provide(testConnection))
  )

  it.live.each([false, true])(
    "requestMany stall returns replies before the stall window ends, noMux=%s",
    (noMux) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe(subject(`many.stall.${noMux}`), { max: 1 })
        yield* subscription.stream.pipe(
          Stream.runForEach((message) => Effect.forEach(["one", "two", "three"], (value) => message.respond(value))),
          Effect.forkChild
        )
        const replies = yield* connection.requestMany(subject(`many.stall.${noMux}`), "hello", {
          strategy: "stall",
          stall: 25,
          maxWait: 1000,
          noMux
        })
        expect(yield* replies.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
          .toEqual(["one", "two", "three"])
      }).pipe(Effect.provide(testConnection))
  )

  it.live("noEcho suppresses own publications while accepting other clients", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const reference = yield* official
      const subscription = yield* connection.subscribe(subject("noecho"), { max: 1 })
      yield* connection.publish(subject("noecho"), "own")
      yield* connection.flush
      reference.publish(subject("noecho"), "external")
      yield* Effect.promise(() => reference.flush())
      const received = yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)
      expect(received).toEqual(["external"])
    }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222", noEcho: true }))))

  it.live("subscription timeout fails a silent stream with a typed error", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("timeout"), { timeout: 25 })
      const error = yield* Stream.runCollect(subscription.stream).pipe(Effect.flip)
      expect(error._tag).toBe("NATSSubscriptionError")
      expect(yield* subscription.isClosed).toBe(true)
      yield* connection.flush
    }).pipe(Effect.provide(testConnection)))

  it.live("malformed JSON is a message decoding failure and preserves subsequent messages", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("json"), { max: 2 })
      yield* connection.publish(subject("json"), "{invalid")
      yield* connection.publish(subject("json"), "{\"valid\":true}")
      const messages = yield* Stream.runCollect(subscription.stream)
      expect((yield* messages[0].json().pipe(Effect.flip))._tag).toBe("NATSMessageError")
      expect(yield* messages[1].json()).toEqual({ valid: true })
    }).pipe(Effect.provide(testConnection)))

  it.live("initializes one multiplexed reply subscription under concurrent requests", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const reference = yield* official
      reference.subscribe(subject("concurrent.request"), {
        callback: (_error, message) => {
          message.respond(message.data)
        }
      })
      yield* Effect.promise(() => reference.flush())
      const replies = yield* Effect.all(
        Array.from({ length: 100 }, (_, index) =>
          connection.request(subject("concurrent.request"), `${index}`, { timeout: 1000 }).pipe(
            Effect.flatMap((message) =>
              message.string
            )
          )),
        { concurrency: "unbounded" }
      )
      expect(replies).toEqual(Array.from({ length: 100 }, (_, index) => `${index}`))
    }).pipe(Effect.scoped, Effect.provide(testConnection)))

  it.live("an asynchronous callback does not block socket reads, flush or other responders", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const callback = yield* connection.subscribe(subject("callback.block"), {
        callback: (_error, message) =>
          Effect.gen(function*() {
            expect(yield* Option.getOrThrow(message).string.pipe(Effect.orDie)).toBe("blocked")
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            yield* Deferred.succeed(completed, undefined)
          })
      })
      const responder = yield* connection.subscribe(subject("callback.other"), { max: 1 })
      yield* responder.stream.pipe(Stream.runForEach((message) => message.respond("unblocked")), Effect.forkChild)
      yield* connection.publish(subject("callback.block"), "blocked")
      yield* Deferred.await(started)
      yield* connection.flush
      const reply = yield* connection.request(subject("callback.other"), "hello", { timeout: 1000 })
      expect(yield* reply.string).toBe("unblocked")
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(completed)
      yield* callback.unsubscribe()
    }).pipe(Effect.provide(testConnection)))

  it.live("unsubscribe(max) closes when the already-received count exceeds the new limit", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("received.max"))
      for (const payload of ["one", "two", "three"]) yield* connection.publish(subject("received.max"), payload)
      yield* connection.flush
      expect(yield* subscription.getReceived).toBe(3)
      yield* subscription.unsubscribe(2)
      expect(yield* subscription.isClosed).toBe(true)
      expect(yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
        .toEqual(["one", "two", "three"])
    }).pipe(Effect.provide(testConnection)))

  it.live("header byte counts match payload and encoded header lengths", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const subscription = yield* connection.subscribe(subject("header.stats"), { max: 1 })
      const messageHeaders = headers()
      messageHeaders.append("X-Test", "value")
      const expectedBytes = 5 + messageHeaders.encode().length
      const before = yield* connection.stats
      yield* connection.publish(subject("header.stats"), "hello", { headers: messageHeaders })
      yield* connection.flush
      yield* Stream.runCollect(subscription.stream)
      const after = yield* connection.stats
      expect(after.outBytes - before.outBytes).toBe(expectedBytes)
      expect(after.inBytes - before.inBytes).toBe(expectedBytes)
    }).pipe(Effect.provide(testConnection)))

  it.live("status streams broadcast reconnect events to independent observers", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const first = yield* connection.status
      const second = yield* connection.status
      const events = yield* Queue.unbounded<string>()
      const watch = (stream: typeof first) =>
        stream.pipe(
          Stream.filter((status) => status.type === "reconnect"),
          Stream.take(1),
          Stream.runForEach((status) => Queue.offer(events, status.type))
        )
      yield* watch(first).pipe(Effect.forkChild)
      yield* watch(second).pipe(Effect.forkChild)
      yield* connection.flush
      yield* connection.reconnect
      expect(yield* Queue.take(events)).toBe("reconnect")
      expect(yield* Queue.take(events)).toBe("reconnect")
    }).pipe(Effect.provide(testConnection)))
})
