import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Schema, Scope, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSNodeConnection from "../src/NATSNodeConnection.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"
import { testConnection } from "./dependencies.ts"
import { makeServer } from "./server.ts"

const subject = () => `native.subscription.${crypto.randomUUID()}`
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(testConnection))
const Connz = Schema.Struct({
  connections: Schema.Array(Schema.Struct({
    cid: Schema.Number,
    subscriptions: Schema.Number,
    subscriptions_list: Schema.optional(Schema.Array(Schema.String))
  }))
})
const interest = (url: string, connection: NATSConnection.NATSConnection) =>
  Effect.tryPromise({
    try: async () => (await fetch(url + "/connz?subs=1")).json(),
    catch: (cause) => new Error("Cannot inspect broker interest", { cause })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Connz)),
    Effect.map((info) => info.connections.find((entry) => entry.cid === Option.getOrThrow(connection.info).client_id)),
    Effect.map(Option.fromNullishOr),
    Effect.map(Option.getOrThrow)
  )
const monitored = <A, E, R>(
  test: (connection: NATSConnection.NATSConnection, url: string) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const server = yield* makeServer({ config: "http: 8080\n" })
    const connection = yield* NATSNodeConnection.make({ servers: server.url })
    return yield* test(connection, server.websocketUrl.replace("ws:", "http:"))
  }).pipe(Effect.scoped)

describe("Exact subscription lifetime and disposal laws", () => {
  it.live.each([
    { name: "max option", initial: 10, changed: undefined, expected: 10 },
    { name: "unsubscribe", initial: 10, changed: 11, expected: 11 },
    { name: "can unsub from auto-unsubscribed", initial: 1, changed: undefined, expected: 1 },
    { name: "can change auto-unsub to a higher value", initial: 1, changed: 10, expected: 10 }
  ])("autounsub - $name", ({ initial, changed, expected }) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const sub = yield* connection.subscribe(address, { max: initial })
      if (changed !== undefined) yield* sub.unsubscribe(changed)
      for (let index = 0; index < 20; index++) yield* connection.publish(address)
      yield* connection.flush
      expect(yield* sub.getReceived).toBe(expected)
      expect(yield* sub.isClosed).toBe(true)
      yield* sub.unsubscribe()
      expect((yield* Stream.runCollect(sub.stream)).length).toBe(expected)
      expect(yield* sub.getProcessed).toBe(expected)
    })))

  it.live("autounsub - can break to unsub", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const sub = yield* connection.subscribe(address, { max: 20 })
      for (let index = 0; index < 20; index++) yield* connection.publish(address)
      yield* sub.stream.pipe(Stream.rechunk(1), Stream.take(1), Stream.runDrain)
      yield* connection.flush
      expect(yield* sub.getProcessed).toBe(1)
      expect(yield* sub.isClosed).toBe(true)
    })))

  it.live("autounsub - request receives expected count with multiple helpers", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const subs = yield* Effect.forEach(Array.from({ length: 5 }), () =>
        connection.subscribe(address, {
          callback: (_error, message) => Option.getOrThrow(message).respond().pipe(Effect.asVoid, Effect.orDie)
        }))
      yield* connection.request(address)
      yield* connection.drain
      const counts = yield* Effect.forEach(subs, (sub) => sub.getReceived)
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(5)
    })))

  it.live("autounsub - manual request receives expected count with multiple helpers", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const reply = yield* connection.createInbox
      const sub = yield* connection.subscribe(reply, { max: 5 })
      yield* Effect.forEach(Array.from({ length: 5 }), () =>
        connection.subscribe(address, {
          callback: (_error, message) => Option.getOrThrow(message).respond().pipe(Effect.asVoid, Effect.orDie)
        }))
      yield* connection.publish(address, undefined, { reply })
      expect((yield* Stream.runCollect(sub.stream)).length).toBe(5)
      yield* connection.drain
      expect(yield* sub.getReceived).toBe(5)
    })))

  it.live("autounsub - check subscription leaks", () =>
    monitored((connection, url) =>
      Effect.gen(function*() {
        const sub = yield* connection.subscribe(subject())
        yield* sub.unsubscribe()
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(0)
      })
    ))

  it.live("autounsub - check request leaks", () =>
    monitored((connection, url) =>
      Effect.gen(function*() {
        const address = subject()
        const arrived = yield* Queue.unbounded<void>()
        const release = yield* Deferred.make<void>()
        const responder = yield* connection.subscribe(address, {
          callback: (_error, message) =>
            Effect.gen(function*() {
              yield* Queue.offer(arrived, undefined)
              yield* Deferred.await(release)
              yield* Option.getOrThrow(message).respond()
            }).pipe(Effect.orDie)
        })
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(1)
        const first = yield* connection.request(address).pipe(Effect.forkChild)
        const second = yield* connection.request(address).pipe(Effect.forkChild)
        yield* Queue.take(arrived)
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(2)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* responder.unsubscribe()
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(1)
        const echo = yield* connection.subscribe(address, {
          callback: (_error, message) => Option.getOrThrow(message).respond().pipe(Effect.asVoid, Effect.orDie)
        })
        yield* connection.request(address)
        yield* echo.unsubscribe()
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(1)
      })
    ))

  it.live.each([false, true])(
    "autounsub - cancelled request cleanup silent=%s",
    (silent) =>
      monitored((connection, url) =>
        Effect.gen(function*() {
          const address = subject()
          const responder = silent ? yield* connection.subscribe(address, { callback: () => {} }) : undefined
          const failure = yield* connection.request(address, undefined, { timeout: 25 }).pipe(Effect.flip)
          expect(failure.code).toBe(silent ? "timeout" : "no_responders")
          yield* connection.flush
          expect((yield* interest(url, connection)).subscriptions).toBe(silent ? 2 : 1)
          if (responder !== undefined) yield* responder.unsubscribe()
          yield* connection.flush
          expect((yield* interest(url, connection)).subscriptions).toBe(1)
          const echo = yield* connection.subscribe(address, {
            callback: (_error, message) => Option.getOrThrow(message).respond().pipe(Effect.asVoid, Effect.orDie)
          })
          yield* connection.request(address)
          yield* echo.unsubscribe()
        })
      )
  )

  it.live.each(["single", "multiple", "independent"])("queues - $0", (mode) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const address = subject()
      const group = (queue: string) =>
        Effect.forEach(Array.from({ length: 5 }), () => connection.subscribe(address, { queue }))
      const first = yield* group("a")
      const second = mode === "multiple" ? yield* group("b") : []
      const observer = mode === "independent" ? yield* connection.subscribe(address) : undefined
      yield* connection.publish(address)
      yield* connection.flush
      const counts = yield* Effect.forEach(first, (sub) => sub.getReceived)
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1)
      if (second.length > 0) {
        const other = yield* Effect.forEach(second, (sub) => sub.getReceived)
        expect(other.reduce((sum, count) => sum + count, 0)).toBe(1)
      }
      if (observer !== undefined) expect(yield* observer.getReceived).toBe(1)
    })))

  it.live.each([false, true])("resub - preserves counters callback=%s", (callback) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const first = subject()
      const second = subject()
      const values: Array<string> = []
      const sub = yield* connection.subscribe(
        first,
        callback ?
          {
            max: 2,
            callback: (_error, message) => {
              const value = Option.getOrThrow(message)
              values.push(value.subject)
              return value.respond().pipe(Effect.asVoid, Effect.orDie)
            }
          } :
          { max: 2 }
      )
      const worker = callback ? undefined : yield* sub.stream.pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => values.push(message.subject)).pipe(Effect.andThen(message.respond()))
        ),
        Effect.forkChild
      )
      yield* connection.request(first)
      const originalID = yield* sub.getID
      yield* sub.resubscribe(second)
      expect(yield* sub.getSubject).toBe(second)
      expect(yield* sub.getID).not.toBe(originalID)
      yield* connection.request(second)
      if (worker !== undefined) yield* Fiber.join(worker)
      yield* sub.drain.pipe(Effect.ignore)
      expect(yield* sub.getReceived).toBe(2)
      expect(yield* sub.getProcessed).toBe(2)
      expect(values).toEqual([first, second])
    })))

  it.live("resub - removes server interest", () =>
    monitored((connection, url) =>
      Effect.gen(function*() {
        const sub = yield* connection.subscribe("a", { callback: () => {} })
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions_list).toEqual(["a"])
        yield* sub.resubscribe("b")
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions_list).toEqual(["b"])
        yield* sub.unsubscribe()
        yield* connection.flush
        expect((yield* interest(url, connection)).subscriptions).toBe(0)
      })
    ))

  it.live.each([false, true])("timeout - request diagnostics noMux=%s", (noMux) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const request = Effect.fn("timeout request caller")(function*() {
        return yield* connection.request(subject(), undefined, { noMux, timeout: 250 })
      })
      const exit = yield* Effect.exit(request())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("timeout request caller")
        expect(Cause.pretty(exit.cause)).toContain("No responders")
      }
    })))

  it.live("dispose - connection scope calls drain", () =>
    Effect.gen(function*() {
      const connection = yield* Effect.scoped(
        NATSNodeConnection.make({ servers: "localhost:4222" }).pipe(
          Effect.tap((connection) =>
            connection.isClosed.pipe(Effect.tap((closed) => Effect.sync(() => expect(closed).toBe(false))))
          )
        )
      )
      expect(yield* connection.isClosed).toBe(true)
      expect(yield* connection.closed).toEqual(Option.none())
    }))

  it.live.each([false, true])("dispose - connection finalization closed=%s", (closed) =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const connection = yield* NATSNodeConnection.make({ servers: "localhost:4222" }).pipe(Scope.provide(scope))
      const drain = closed ? undefined : yield* connection.drain.pipe(Effect.forkChild({ startImmediately: true }))
      if (closed) yield* connection.close
      yield* Scope.close(scope, Exit.void)
      yield* Scope.close(scope, Exit.void)
      if (drain !== undefined) yield* Fiber.join(drain)
      expect(yield* connection.isClosed).toBe(true)
    }))

  it.live.each(["callback", "iterator", "empty", "closed", "draining", "connection closed"])(
    "dispose - subscription scope $0",
    (mode) =>
      live(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const address = subject()
        let captured: NATSSubscription.NATSSubscription | undefined
        let count = 0
        yield* Effect.scoped(Effect.gen(function*() {
          const sub = yield* Effect.acquireRelease(
            connection.subscribe(
              address,
              mode === "callback"
                ? {
                  callback: () => {
                    count++
                  }
                }
                : {}
            ),
            (sub) => sub.drain.pipe(Effect.ignore)
          )
          captured = sub
          const worker = mode === "callback" ? undefined : yield* sub.stream.pipe(
            Stream.runForEach(() =>
              Effect.sync(() => {
                count++
              })
            ),
            Effect.forkChild
          )
          if (mode === "callback" || mode === "iterator") {
            yield* connection.publish(address)
            yield* connection.publish(address)
            yield* connection.flush
          }
          if (mode === "closed") yield* sub.drain
          if (mode === "connection closed") yield* connection.close
          if (mode === "draining") yield* sub.drain.pipe(Effect.forkChild)
          if (worker !== undefined && (mode === "closed" || mode === "connection closed")) yield* Fiber.join(worker)
        }))
        expect(captured).toBeDefined()
        if (captured === undefined) return
        expect(yield* captured.isClosed).toBe(true)
        expect(yield* captured.closed).toEqual(Option.none())
        expect(count).toBe(mode === "callback" || mode === "iterator" ? 2 : 0)
      }))
  )

  it.live("dispose - script use", () =>
    live(Effect.gen(function*() {
      const service = yield* NATSConnection.NATSConnection
      const address = subject()
      yield* service.subscribe(address, {
        callback: (_error, message) => Option.getOrThrow(message).respond().pipe(Effect.asVoid, Effect.orDie)
      })
      for (let index = 0; index < 2; index++) {
        const connection = yield* Effect.scoped(Effect.gen(function*() {
          const connection = yield* NATSNodeConnection.make({ servers: "localhost:4222" })
          const sub = yield* connection.subscribe(address)
          yield* sub.stream.pipe(Stream.runDrain, Effect.forkChild)
          yield* connection.request(address)
          return connection
        }))
        expect(yield* connection.isClosed).toBe(true)
        expect(yield* connection.closed).toEqual(Option.none())
      }
    })))
})
