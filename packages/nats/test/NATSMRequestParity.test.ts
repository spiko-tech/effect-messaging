import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Schema, Stream } from "effect"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSError from "../src/NATSError.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeServer } from "./server.ts"

const subject = "native.mrequest.parity"
const monitoring = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ cid: Schema.Number, subscriptions: Schema.Number }))
})
const fixture = <A, E, R>(
  test: (server: Effect.Success<ReturnType<typeof makeServer>>) => Effect.Effect<A, E, R>,
  options: NATSOptions.NodeConnectionOptions = {},
  config = ""
) =>
  Effect.gen(function*() {
    const server = yield* makeServer({ config: "http: 8080\n" + config })
    return yield* test(server).pipe(
      Effect.scoped,
      Effect.provide(NATSConnection.layerNode({ ...options, servers: server.url }))
    )
  }).pipe(Effect.scoped)
const countSubscriptions = (server: Effect.Success<ReturnType<typeof makeServer>>, cid: number) =>
  Effect.tryPromise({
    try: async () => (await fetch(server.websocketUrl.replace("ws:", "http:") + "/connz")).json(),
    catch: (cause) => new Error("Monitoring failed", { cause })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(monitoring)),
    Effect.map((value) => value.connections.find((entry) => entry.cid === cid)?.subscriptions)
  )
const matrix = [false, true].flatMap((noMux) =>
  [
    { label: "count", noMux, strategy: "count", count: 5, sentinel: false },
    { label: "jitter", noMux, strategy: "stall", count: 10, sentinel: false },
    { label: "sentinel", noMux, strategy: "sentinel", count: 10, sentinel: true },
    { label: "sentinel partial", noMux, strategy: "sentinel", count: 10, sentinel: false },
    { label: "timer no response", noMux, strategy: "timer", count: 0, sentinel: false },
    { label: "timer late response", noMux, strategy: "timer", count: 1, sentinel: false }
  ] as const
)

describe("Exact upstream multi-request laws", { concurrent: false }, () => {
  it.live.each(matrix)("mreq - $label noMux=$noMux", (options) =>
    fixture((server) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        let payload = ""
        yield* connection.subscribe(subject, {
          callback: (_error, incoming) =>
            Option.isSome(incoming) ?
              Effect.gen(function*() {
                payload = yield* incoming.value.string
                if (options.label === "timer late response") yield* Effect.sleep("75 millis")
                for (let index = 0; index < options.count; index++) {
                  yield* incoming.value.respond(options.strategy === "sentinel" ? "hello" : undefined)
                }
                if (options.sentinel) yield* incoming.value.respond()
              }).pipe(Effect.orDie) :
              undefined
        })
        const cid = Option.getOrThrow(connection.info).client_id ?? -1
        const fullWait = options.strategy === "timer" || options.label === "sentinel partial"
        const started = Date.now()
        const replies = yield* connection.requestMany(subject, "hello", {
          strategy: options.strategy,
          maxWait: fullWait ? 100 : 2000,
          ...(options.strategy === "count" ? { maxMessages: 5 } : {}),
          noMux: options.noMux
        })
        const messages = yield* Stream.runCollect(replies)
        expect(messages).toHaveLength(options.count + (options.sentinel ? 1 : 0))
        expect(payload).toBe("hello")
        if (fullWait) expect(Date.now() - started).toBeGreaterThanOrEqual(100)
        else expect(Date.now() - started).toBeLessThan(500)
        yield* connection.flush
        expect(yield* countSubscriptions(server, cid)).toBe(options.noMux ? 1 : 2)
      })
    ))

  it.live.each([false, true])(
    "mreq - request many stops on error noMux=%s",
    (noMux) =>
      fixture((server) =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const cid = Option.getOrThrow(connection.info).client_id ?? -1
          const responses = yield* connection.requestMany(subject, undefined, { noMux, maxWait: 2000 })
          const error = yield* Stream.runCollect(responses).pipe(Effect.flip)
          expect(error.code).toBe("no_responders")
          expect(error.subject).toBe(subject)
          yield* connection.flush
          expect(yield* countSubscriptions(server, cid)).toBe(noMux ? 0 : 1)
        })
      )
  )

  it.live("mreq - timeout doesn't leak subs", () =>
    fixture((server) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const cid = Option.getOrThrow(connection.info).client_id ?? -1
        yield* connection.subscribe(subject, { callback: () => undefined })
        yield* connection.flush
        expect(yield* countSubscriptions(server, cid)).toBe(1)
        const responses = yield* connection.requestMany(subject, undefined, { noMux: true, maxWait: 100 })
        expect(yield* Stream.runCollect(responses)).toEqual([])
        yield* connection.flush
        expect(yield* countSubscriptions(server, cid)).toBe(1)
      })
    ))

  it.live.each(["publish", "subscription"] as const)(
    "mreq - %s permission error",
    (operation) =>
      fixture(
        (server) =>
          Effect.gen(function*() {
            const connection = yield* NATSConnection.NATSConnection
            const cid = Option.getOrThrow(connection.info).client_id ?? -1
            const errors = yield* Queue.unbounded<Error>()
            const status = yield* connection.status
            const watching = yield* status.pipe(
              Stream.runForEach((event) =>
                event.type === "error" ? Queue.offer(errors, event.error).pipe(Effect.asVoid) : Effect.void
              ),
              Effect.forkChild
            )
            if (operation === "subscription") {
              yield* connection.subscribe("q", {
                callback: (_error, incoming) =>
                  Option.isSome(incoming)
                    ? incoming.value.respond().pipe(Effect.asVoid, Effect.orDie)
                    : undefined
              })
            }
            const error = yield* connection.requestMany("q", undefined, {
              noMux: operation === "subscription",
              strategy: "count",
              maxMessages: 3,
              maxWait: 1000
            }).pipe(Effect.flatMap(Stream.runCollect), Effect.flip)
            expect(error.code).toBe("permissions")
            expect(error.reason).toMatch(/Permissions Violation/i)
            const notification = yield* Queue.take(errors)
            expect(notification).toBeInstanceOf(NATSError.NATSConnectionError)
            if (notification instanceof NATSError.NATSConnectionError) {
              expect(notification.reason).toMatch(new RegExp("Permissions Violation for " + operation, "i"))
              expect(notification.code).toBe("permissions")
              expect(notification.subject).toMatch(operation === "publish" ? /^q$/ : /^_INBOX\./)
            }
            yield* connection.flush
            expect(yield* countSubscriptions(server, cid)).toBe(1)
            yield* Fiber.interrupt(watching)
          }),
        { user: "a", pass: "a" },
        `authorization { users: [{user:"a",password:"a",permissions:{${
          operation === "publish"
            ? "publish:{deny:[\"q\"]}"
            : "subscribe:{deny:[\"_INBOX.>\"]}"
        }}}] }`
      )
  )

  it.live("mreq - lost sub permission", () =>
    fixture(
      (server) =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          let reloaded = false
          yield* connection.subscribe("q", {
            callback: (_error, incoming) =>
              Option.isSome(incoming) ?
                Effect.gen(function*() {
                  yield* incoming.value.respond()
                  if (!reloaded) {
                    reloaded = true
                    yield* server.reload(
                      "http:8080\nauthorization { users: [{user:\"a\",password:\"a\",permissions:{subscribe:{deny:[\"_INBOX.>\"]}}}] }"
                    )
                  }
                }).pipe(Effect.orDie) :
                undefined
          })
          const responses = yield* connection.requestMany("q", undefined, {
            noMux: true,
            strategy: "count",
            maxMessages: 100,
            maxWait: 2000
          })
          const error = yield* Stream.runCollect(responses).pipe(Effect.flip)
          expect(reloaded).toBe(true)
          expect(error.code).toBe("permissions")
          expect(error.reason).toMatch(/Permissions Violation/i)
        }),
      { user: "a", pass: "a" },
      "authorization { users: [{user:\"a\",password:\"a\"}] }"
    ))

  it.live("mreq - no mux request no perms doesn't leak subs", () =>
    fixture(
      (server) =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const cid = Option.getOrThrow(connection.info).client_id ?? -1
          const error = yield* connection.requestMany("qq", undefined, { noMux: true, maxWait: 1000 }).pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.flip
          )
          expect(error.code).toBe("permissions")
          expect(error.reason).toMatch(/Permissions Violation for Publish/i)
          yield* connection.flush
          expect(yield* countSubscriptions(server, cid)).toBe(0)
        }),
      { user: "s", pass: "s" },
      "authorization { users: [{user:\"s\",password:\"s\",permissions:{publish:{allow:[\"q\"]},subscribe:{allow:[\">\"]}}}] }"
    ))

  it.live("basics - request many tracing", () =>
    fixture(() =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const responder = yield* connection.subscribe("foo", {
          callback: (_error, incoming) =>
            Option.isSome(incoming)
              ? incoming.value.respond().pipe(Effect.andThen(incoming.value.respond()), Effect.asVoid, Effect.orDie)
              : undefined
        })
        const traces = yield* connection.subscribe("traces", { max: 2 })
        yield* connection.flush
        for (const traceOnly of [false, true]) {
          const replies = yield* connection.requestMany("foo", undefined, {
            strategy: "stall",
            maxWait: 150,
            traceDestination: "traces",
            ...(traceOnly ? { traceOnly: true } : {})
          })
          expect(yield* Stream.runCollect(replies)).toHaveLength(traceOnly ? 0 : 2)
        }
        expect(yield* Stream.runCollect(traces.stream)).toHaveLength(2)
        expect(yield* responder.getReceived).toBe(1)
      })
    ))
})
