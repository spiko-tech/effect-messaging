import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Pull, Queue, Schema, Stream } from "effect"
import { createServer, isIP } from "node:net"
import * as JetStreamApi from "../src/internal/jetstreamApi.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSHeaders from "../src/NATSHeaders.ts"
import * as NATSInbox from "../src/NATSInbox.ts"
import * as NATSMessage from "../src/NATSMessage.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"
import { makeServer } from "./server.ts"

const subject = "native.basics.parity"
const live = <A, E, R>(test: Effect.Effect<A, E, R>, options: NATSOptions.NodeConnectionOptions = {}) =>
  test.pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode(options)))
const broker = <A, E, R>(
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
const echo = Effect.gen(function*() {
  const connection = yield* NATSConnection.NATSConnection
  yield* connection.subscribe(subject, {
    callback: (_error, message) =>
      Option.isSome(message) ? message.value.respond(message.value.data).pipe(Effect.asVoid, Effect.orDie) : undefined
  })
  return connection
})
const Connz = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ cid: Schema.Number, subscriptions: Schema.Number }))
})
const subscriptionCount = (url: string, cid: number) =>
  Effect.tryPromise({
    try: async () => (await fetch(url.replace("ws:", "http:") + "/connz")).json(),
    catch: (cause) => new Error("Monitoring request failed", { cause })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Connz)),
    Effect.map((value) => value.connections.find((connection) => connection.cid === cid)?.subscriptions)
  )

describe("Exact upstream core basics laws", { concurrent: false }, () => {
  it.live.each([
    { label: "port", options: { port: 4222 } },
    { label: "default", options: {} },
    { label: "host", options: { servers: "localhost" } },
    { label: "hostport", options: { servers: "localhost:4222" } },
    { label: "servers", options: { servers: ["localhost:4222"] } },
    { label: "scott", options: { servers: "localhost:4222", debug: true } },
    { label: "debug", options: { debug: true } },
    { label: "ipv4 mapped to ipv6", options: { servers: "[::ffff:127.0.0.1]:4222" } }
  ])("basics - connect $label", ({ options }) =>
    live(
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        yield* connection.flush
        expect(yield* connection.isClosed).toBe(false)
        yield* connection.close
        expect(yield* connection.isClosed).toBe(true)
      }),
      options
    ))

  it.live("basics - publish", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.publish(subject)
      yield* connection.flush
    })))

  it.live("basics - subscribe and unsubscribe", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject, { max: 1000, queue: "native" })
      expect(yield* sub.getSubject).toBe(subject)
      expect(yield* sub.getReceived).toBe(0)
      expect(yield* sub.getMax).toEqual(Option.some(1000))
      yield* sub.unsubscribe(10)
      expect(yield* sub.getMax).toEqual(Option.some(10))
      yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.getReceived).toBe(1)
      yield* sub.unsubscribe()
      expect(yield* sub.isClosed).toBe(true)
    })))

  it.live("basics - subscribe returns Subscription", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject)
      expect(yield* sub.getID).toBe(1)
    })))

  it.live("basics - wildcard subscriptions", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const first = yield* connection.subscribe(subject + ".*")
      const second = yield* connection.subscribe(subject + ".foo.bar.*")
      const third = yield* connection.subscribe(subject + ".foo.>")
      for (const suffix of ["bar", "baz", "foo.bar.1", "foo.bar.2", "foo.baz.3", "foo.baz.foo", "foo.baz", "foo"]) {
        yield* connection.publish(subject + "." + suffix)
      }
      yield* connection.drain
      expect(yield* first.getReceived).toBe(3)
      expect(yield* second.getReceived).toBe(2)
      expect(yield* third.getReceived).toBe(5)
    })))

  it.live.each([false, true])("basics - correct message metadata, reply=%s", (reply) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject + ".*", { max: 1 })
      yield* connection.publish(subject + ".exact", subject, reply ? { reply: subject + ".reply" } : {})
      const messages = yield* Stream.runCollect(sub.stream)
      expect(messages[0].subject).toBe(subject + ".exact")
      expect(yield* messages[0].string).toBe(subject)
      expect(messages[0].reply).toEqual(reply ? Option.some(subject + ".reply") : Option.none())
      if (!reply) expect(yield* messages[0].respond()).toBe(false)
    })))

  it.live.each(["subscribe", "request"] as const)(
    "basics - closed cannot %s",
    (operation) =>
      live(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        yield* connection.close
        const error = yield* (operation === "subscribe"
          ? connection.subscribe(subject).pipe(Effect.asVoid)
          : connection.request(subject).pipe(Effect.asVoid)).pipe(Effect.flip)
        expect(error.code).toBe("closed")
      }))
  )

  it.live("basics - unsubscribe after close", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject)
      yield* connection.close
      yield* sub.unsubscribe()
      expect(yield* sub.isClosed).toBe(true)
    })))

  it.live("basics - flush returns effect", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      expect(Effect.isEffect(connection.flush)).toBe(true)
      yield* connection.flush
    })))

  it.live("basics - unsubscribe stops messages", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const handled = yield* Deferred.make<void>()
      const sub: NATSSubscription.NATSSubscription = yield* connection.subscribe(subject, {
        callback: () => sub.unsubscribe().pipe(Effect.andThen(Deferred.succeed(handled, undefined)))
      })
      for (let index = 0; index < 4; index++) yield* connection.publish(subject)
      yield* Deferred.await(handled)
      yield* connection.flush
      expect(yield* sub.getReceived).toBe(1)
    })))

  it.live.each([false, true])("basics - request no responders, noMux=%s", (noMux) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const error = yield* connection.request(subject, undefined, { noMux, timeout: 1000 }).pipe(Effect.flip)
      expect(error.code).toBe("no_responders")
      expect(error.subject).toBe(subject)
    })))

  it.live.each([false, true])("basics - request timeout, noMux=%s", (noMux) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject, { callback: () => undefined })
      const error = yield* connection.request(subject, undefined, { noMux, timeout: 25 }).pipe(Effect.flip)
      expect(error.code).toBe("timeout")
    })))

  it.live.each([false, true])(
    "basics - request with headers and custom reply=%s",
    (custom) =>
      live(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        yield* connection.subscribe(subject, {
          callback: (_error, message) =>
            Option.isSome(message)
              ? message.value.respond(Option.getOrThrow(message.value.headers).get("test-header")).pipe(
                Effect.asVoid,
                Effect.orDie
              )
              : undefined
        })
        const headers = NATSHeaders.headers()
        headers.set("test-header", "Hello, world!")
        const response = yield* connection.request(subject, undefined, {
          headers,
          ...(custom ? { noMux: true, reply: subject + ".custom.reply" } : {})
        })
        expect(yield* response.string).toBe("Hello, world!")
        if (custom) expect(response.subject).toBe(subject + ".custom.reply")
      }))
  )

  it.live("basics - reply can only be used with noMux", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const error = yield* connection.request(subject, undefined, { reply: subject + ".reply" }).pipe(Effect.flip)
      expect(error.code).toBe("invalid_argument")
    })))

  it.live("basics - close cancels requests", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const admitted = yield* Deferred.make<void>()
      yield* connection.subscribe(subject, {
        callback: () => Deferred.succeed(admitted, undefined).pipe(Effect.asVoid)
      })
      const pending = yield* connection.request(subject).pipe(Effect.forkChild)
      yield* Deferred.await(admitted)
      yield* connection.close
      const error = yield* Fiber.join(pending).pipe(Effect.flip)
      expect(error.code).toBe("closed")
    })))

  it.live("basics - subs pending count", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject, { max: 10 })
      for (let index = 0; index < 10; index++) yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.getPending).toBe(10)
      let processed = 0
      yield* Stream.runForEach(sub.stream, () =>
        Effect.gen(function*() {
          processed++
          expect(yield* sub.getProcessed).toBe(processed)
          expect((yield* sub.getProcessed) + (yield* sub.getPending)).toBe(10)
        }))
    })))

  it.live.each([false, true])("basics - custom prefix, noMux=%s", (noMux) =>
    live(
      Effect.gen(function*() {
        const connection = yield* echo
        const response = yield* connection.request(subject, undefined, { noMux })
        expect(response.subject.startsWith("_native.")).toBe(true)
      }),
      { inboxPrefix: "_native" }
    ))

  it.live("basics - subscription expecting 2 doesn't fire timeout", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject, { max: 2, timeout: 25 })
      yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.closed.pipe(Effect.timeoutOption(75))).toEqual(Option.none())
      expect(yield* sub.getReceived).toBe(1)
      yield* connection.publish(subject)
      expect((yield* Stream.runCollect(sub.stream)).length).toBe(2)
    })))

  it.live("basics - msg typed payload", () =>
    live(Effect.gen(function*() {
      const connection = yield* echo
      for (const value of [null, 5, "hello", ["hello"], { one: "two" }, [{ one: "two" }]]) {
        const reply = yield* connection.request(subject, JSON.stringify(value))
        expect(yield* reply.json()).toEqual(value)
      }
      const empty = yield* connection.request(subject)
      expect(yield* empty.string).toBe("")
      expect((yield* empty.json().pipe(Effect.flip))._tag).toBe("NATSMessageError")
      const text = yield* connection.request(subject, "hello")
      expect(yield* text.string).toBe("hello")
    })))

  it.live.each(["", "hello"])("basics - data types string %j", (payload) =>
    live(Effect.gen(function*() {
      const connection = yield* echo
      const sub = yield* connection.subscribe(subject, { max: 1 })
      yield* connection.publish(subject, payload)
      expect(yield* (yield* Stream.runCollect(sub.stream))[0].string).toBe(payload)
      expect(yield* (yield* connection.request(subject, payload)).string).toBe(payload)
      const many = yield* connection.requestMany(subject, payload, { strategy: "count", maxMessages: 1, maxWait: 1000 })
      expect(yield* (yield* Stream.runCollect(many))[0].string).toBe(payload)
    })))

  it.live.each([undefined, Uint8Array.of()])("basics - data types empty %j", (payload) =>
    live(Effect.gen(function*() {
      const connection = yield* echo
      const sub = yield* connection.subscribe(subject, { max: 1 })
      yield* connection.publish(subject, payload)
      expect((yield* Stream.runCollect(sub.stream))[0].data.length).toBe(0)
      expect((yield* connection.request(subject, payload)).data.length).toBe(0)
      const many = yield* connection.requestMany(subject, payload, { strategy: "count", maxMessages: 1, maxWait: 1000 })
      expect((yield* Stream.runCollect(many))[0].data.length).toBe(0)
    })))

  it.live("basics - json reviver", () =>
    live(Effect.gen(function*() {
      const connection = yield* echo
      const message = yield* connection.request(subject, JSON.stringify({ date: 1000, auth: true }))
      const value = yield* message.json<{ date: Date; auth: string }>((key, value) =>
        key === "date" ? new Date(Number(value)) : typeof value === "boolean" ? value ? "yes" : "no" : value
      )
      expect(value.date).toEqual(new Date(1000))
      expect(value.auth).toBe("yes")
    })))

  it.live("basics - sync subscription becomes scoped stream pulls", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject)
      const pull = yield* Stream.toPull(sub.stream)
      yield* connection.publish(subject)
      expect((yield* pull).length).toBe(1)
      yield* sub.unsubscribe()
      const end = yield* pull.pipe(Effect.exit)
      expect(end._tag).toBe("Failure")
      if (end._tag === "Failure") expect(Pull.isDoneCause(end.cause)).toBe(true)
    })))

  it.live.each(["publish", "respond"] as const)("basics - %s message", (mode) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject, {
        callback: (_error, incoming) =>
          Option.isSome(incoming) ?
            Effect.gen(function*() {
              const reply = Option.getOrThrow(incoming.value.reply)
              const message = NATSMessage.make({
                subject: mode === "publish" ? reply : subject,
                reply,
                sid: -1,
                data: new TextEncoder().encode("not in service")
              }, connection.publish)
              if (mode === "publish") yield* connection.publishMessage(message)
              else expect(yield* connection.respondMessage(message)).toBe(true)
            }).pipe(Effect.orDie) :
            undefined
      })
      expect(yield* (yield* connection.request(subject)).string).toBe("not in service")
    })))

  it.live("basics - msg sids", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const first = yield* connection.subscribe(subject, { max: 1 })
      const second = yield* connection.subscribe(">", { max: 1 })
      yield* connection.publish(subject, "hello", { reply: "foo" })
      const one = (yield* Stream.runCollect(first.stream))[0]
      const two = (yield* Stream.runCollect(second.stream))[0]
      expect(one.sid).toBe(yield* first.getID)
      expect(two.sid).toBe(yield* second.getID)
      expect(one.size).toBe(5 + subject.length + 3)
    })))

  it.live("basics - info and api_lvl and client ip", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const info = Option.getOrThrow(connection.info)
      expect(info.server_id.length).toBeGreaterThan(0)
      expect(typeof info.api_lvl).toBe("number")
      expect(isIP(info.client_ip ?? "")).toBeGreaterThan(0)
      yield* connection.close
      expect(connection.info).toEqual(Option.none())
    })))

  it.live("basics - close promise resolves and status closes", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const statuses = yield* connection.status
      const closing = yield* statuses.pipe(Stream.runCollect, Effect.forkChild)
      const closed = yield* connection.closed.pipe(Effect.forkChild)
      yield* connection.close
      expect(yield* Fiber.join(closed)).toEqual(Option.none())
      expect((yield* Fiber.join(closing)).some((event) => event.type === "close")).toBe(true)
    })))

  it.live.each(["timeout", "no responders"] as const)(
    "basics - no mux %s doesn't leak subs",
    (mode) =>
      broker((server) =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          if (mode === "timeout") yield* connection.subscribe(subject, { callback: () => undefined })
          const cid = Option.getOrThrow(connection.info).client_id ?? -1
          const before = yield* subscriptionCount(server.websocketUrl, cid)
          yield* connection.request(subject, undefined, { noMux: true, timeout: 25 }).pipe(Effect.flip)
          yield* connection.flush
          expect(yield* subscriptionCount(server.websocketUrl, cid)).toBe(before)
        })
      )
  )

  it.live("basics - stats match broker counters", () =>
    broker((server) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const cid = Option.getOrThrow(connection.info).client_id
        const headers = NATSHeaders.headers()
        headers.set("hello", "very long value that we want to add here")
        yield* connection.subscribe(subject, { callback: () => undefined })
        yield* connection.publish(subject, "world")
        yield* connection.publish(subject, "hello", { headers })
        yield* connection.flush
        const counters = yield* Effect.tryPromise({
          try: async () => (await fetch(server.websocketUrl.replace("ws:", "http:") + "/connz?cid=" + cid)).json(),
          catch: (cause) => new Error("Monitoring failed", { cause })
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                connections: Schema.Array(
                  Schema.Struct({
                    in_msgs: Schema.Number,
                    out_msgs: Schema.Number,
                    in_bytes: Schema.Number,
                    out_bytes: Schema.Number
                  })
                )
              })
            )
          )
        )
        const stats = yield* connection.stats
        expect(stats).toEqual({
          inMsgs: counters.connections[0].out_msgs,
          outMsgs: counters.connections[0].in_msgs,
          inBytes: counters.connections[0].out_bytes,
          outBytes: counters.connections[0].in_bytes
        })
      })
    ))
  it.effect("basics - create inbox", () =>
    Effect.gen(function*() {
      for (const prefix of ["", undefined, null, "hello"]) {
        // @ts-expect-error Null exercises the JavaScript compatibility boundary.
        const inbox = yield* NATSInbox.createInbox(prefix)
        expect(inbox.startsWith(prefix ? prefix + "." : "_INBOX.")).toBe(true)
      }
      // @ts-expect-error Invalid JavaScript input is deliberately rejected by Schema.
      expect((yield* NATSInbox.createInbox(5).pipe(Effect.flip))._tag).toBe("NATSConnectionError")
    }))

  it.effect("basics - inbox prefixes cannot have wildcards", () =>
    Effect.gen(function*() {
      for (const prefix of ["_inbox.foo.*", "_inbox.foo.>"]) {
        expect((yield* NATSInbox.createInbox(prefix).pipe(Effect.flip)).code).toBe("invalid_argument")
      }
    }))

  it.live("basics - no mux requests create normal subs", () =>
    broker((server) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const admitted = yield* Deferred.make<void>()
        yield* connection.subscribe(subject, {
          callback: () => Deferred.succeed(admitted, undefined).pipe(Effect.asVoid)
        })
        const cid = Option.getOrThrow(connection.info).client_id ?? -1
        const pending = yield* connection.request(subject, undefined, { noMux: true, timeout: 60_000 }).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(admitted)
        expect(yield* subscriptionCount(server.websocketUrl, cid)).toBe(2)
        yield* Fiber.interrupt(pending)
        yield* connection.flush
        expect(yield* subscriptionCount(server.websocketUrl, cid)).toBe(1)
      })
    ))

  it.live("basics - no mux request no perms doesn't leak subs", () =>
    broker(
      (server) =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const cid = Option.getOrThrow(connection.info).client_id ?? -1
          for (
            const options of [
              { subject: "qq", reply: "response" },
              { subject: "q", reply: "r" }
            ]
          ) {
            const error = yield* connection.request(options.subject, undefined, {
              noMux: true,
              reply: options.reply,
              timeout: 1000
            }).pipe(Effect.flip)
            expect(error.code).toBe("permissions")
            yield* connection.flush
            expect(yield* subscriptionCount(server.websocketUrl, cid)).toBe(0)
          }
        }),
      { user: "s", pass: "s" },
      "authorization { users: [{user:\"s\",password:\"s\",permissions:{publish:{allow:[\"q\"]},subscribe:{allow:[\"response\"]}}}] }"
    ))

  it.live("basics - max_payload errors", () =>
    broker(
      () =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const big = new Uint8Array(Option.getOrThrow(connection.info).max_payload + 1)
          expect((yield* connection.publish(subject, big).pipe(Effect.flip)).code).toBe("max_payload")
          expect((yield* connection.request(subject, big).pipe(Effect.flip)).code).toBe("max_payload")
          const responseError = yield* Deferred.make<string>()
          yield* connection.subscribe(subject, {
            callback: (_error, message) =>
              Option.isSome(message) ?
                message.value.respond(big).pipe(
                  Effect.flip,
                  Effect.flatMap((error) => Deferred.succeed(responseError, error._tag)),
                  Effect.asVoid,
                  Effect.orDie
                ) :
                undefined
          })
          const pending = yield* connection.request(subject, undefined, { timeout: 25 }).pipe(Effect.forkChild)
          expect(yield* Deferred.await(responseError)).toBe("NATSMessageError")
          expect((yield* Fiber.join(pending).pipe(Effect.flip)).code).toBe("timeout")
        }),
      {},
      "max_payload: 1024"
    ))

  it.live("basics - msg buffers dont overwrite", () =>
    broker(
      () =>
        Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const sub = yield* connection.subscribe("native.buffer.>", { max: 100 })
          const payload = new Uint8Array(Option.getOrThrow(connection.info).max_payload)
          for (let index = 0; index < 100; index++) {
            payload.fill(index % 26 + 97)
            const exact = "native.buffer." + new TextDecoder().decode(payload.subarray(0, 26))
            yield* connection.publish(exact, payload, { reply: exact })
            yield* connection.flush
          }
          const messages = yield* Stream.runCollect(sub.stream)
          expect(messages).toHaveLength(100)
          for (let index = 0; index < messages.length; index++) {
            expect(messages[index].data).toEqual(new Uint8Array(payload.length).fill(index % 26 + 97))
            expect(messages[index].subject).toBe(
              "native.buffer." + new TextDecoder().decode(messages[index].data.subarray(0, 26))
            )
            expect(messages[index].reply).toEqual(Option.some(messages[index].subject))
          }
        }),
      {},
      "max_payload: 1024"
    ))

  it.live.each(
    [
      { label: "count", strategy: "count", count: 5, terminal: false, maxMessages: 5 },
      { label: "jitter", strategy: "stall", count: 10, terminal: false },
      { label: "sentinel", strategy: "sentinel", count: 10, terminal: true },
      { label: "sentinel - partial response", strategy: "sentinel", count: 10, terminal: false },
      { label: "wait for timer - no respone", strategy: "timer", count: 0, terminal: false }
    ] as const
  )("basics - request many $label", (options) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject, {
        callback: (_error, incoming) =>
          Option.isSome(incoming) ?
            Effect.gen(function*() {
              for (let index = 0; index < options.count; index++) yield* incoming.value.respond("hello")
              if (options.terminal) yield* incoming.value.respond()
            }).pipe(Effect.orDie) :
            undefined
      })
      const short = options.strategy === "timer" || options.label === "sentinel - partial response"
      const start = Date.now()
      const requests = yield* connection.requestMany(subject, undefined, {
        strategy: options.strategy,
        maxWait: short ? 100 : 2000,
        ...(options.strategy === "count" ? { maxMessages: 5 } : {})
      })
      const responses = yield* Stream.runCollect(requests)
      const elapsed = Date.now() - start
      expect(responses).toHaveLength(options.count + (options.terminal ? 1 : 0))
      if (short) expect(elapsed).toBeGreaterThanOrEqual(100)
      else expect(elapsed).toBeLessThan(500)
    })))

  it.live("basics - request many waits for timer late response", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject, {
        callback: (_error, incoming) =>
          Option.isSome(incoming) ?
            // This delay is the late-response stimulus, not a readiness wait.
            Effect.sleep(75).pipe(Effect.andThen(incoming.value.respond()), Effect.asVoid, Effect.orDie) :
            undefined
      })
      const start = Date.now()
      const requests = yield* connection.requestMany(subject, undefined, { strategy: "timer", maxWait: 100 })
      expect(yield* Stream.runCollect(requests)).toHaveLength(1)
      expect(Date.now() - start).toBeGreaterThanOrEqual(100)
    })))

  it.live("basics - slow", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const statuses = yield* connection.status
      const slow = yield* Queue.unbounded<number>()
      const watching = yield* statuses.pipe(
        Stream.runForEach((event) =>
          event.type === "slowConsumer" ? Queue.offer(slow, event.pending).pipe(Effect.asVoid) : Effect.void
        ),
        Effect.forkChild
      )
      const sub = yield* connection.subscribe(subject, { slow: 10 })
      yield* connection.flush
      for (let index = 0; index < 11; index++) yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.getPending).toBe(11)
      expect(yield* Queue.take(slow)).toBe(11)
      yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.getPending).toBe(12)
      expect(yield* Queue.size(slow)).toBe(0)
      const pull = yield* Stream.toPull(sub.stream)
      const messages = yield* pull
      expect(messages.length).toBeGreaterThan(0)
      while ((yield* sub.getPending) > 0) yield* pull
      // Drain available chunks before proving notifications resume only after crossing the threshold.
      for (let index = 0; index < 10; index++) yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* sub.getPending).toBe(10)
      expect(yield* Queue.size(slow)).toBe(0)
      yield* connection.publish(subject)
      yield* connection.flush
      expect(yield* Queue.take(slow)).toBe(11)
      expect(yield* Queue.size(slow)).toBe(0)
      yield* Fiber.interrupt(watching)
    })))

  it.live.each(["publish", "request"] as const)("basics - %s tracing", (operation) =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.subscribe(subject, {
        callback: (_error, message) =>
          Option.isSome(message) ? message.value.respond().pipe(Effect.asVoid, Effect.orDie) : undefined
      })
      const traces = yield* connection.subscribe(subject + ".traces", { max: 2 })
      const ordinary = yield* connection.subscribe(subject, { callback: () => undefined })
      const options = { traceDestination: subject + ".traces" }
      if (operation === "publish") {
        yield* connection.publish(subject, undefined, options)
        yield* connection.publish(subject, undefined, { ...options, traceOnly: true })
      } else {
        yield* connection.request(subject, undefined, options)
        yield* connection.request(subject, undefined, { ...options, traceOnly: true, timeout: 25 }).pipe(Effect.flip)
      }
      expect(yield* Stream.runCollect(traces.stream)).toHaveLength(2)
      expect(yield* ordinary.getReceived).toBe(1)
    })))
  it.live("basics - subscription cb with timeout cancels on message", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const received = yield* Deferred.make<void>()
      const sub = yield* connection.subscribe(subject, {
        max: 2,
        timeout: 25,
        callback: () => Deferred.succeed(received, undefined).pipe(Effect.asVoid)
      })
      yield* connection.publish(subject)
      yield* Deferred.await(received)
      expect(yield* sub.closed.pipe(Effect.timeoutOption(75))).toEqual(Option.none())
      expect(yield* sub.getReceived).toBe(1)
    })))

  it.live("basics - request requires a subject", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      // @ts-expect-error This intentionally exercises the JavaScript input boundary.
      expect((yield* connection.request().pipe(Effect.flip)).code).toBe("invalid_subject")
    })))

  it.live("basics - pub subject verified", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      expect((yield* connection.publish("foo 6\r\npwntus\r\nPUB bar").pipe(Effect.flip)).code).toBe("invalid_subject")
    })))

  it.live("basics - subscription timeout auto cancels", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject, { max: 2, timeout: 25 })
      yield* connection.publish(subject)
      yield* connection.publish(subject)
      expect(yield* Stream.runCollect(sub.stream)).toHaveLength(2)
      expect(yield* sub.closed).toEqual(Option.none())
    })))

  it.live("basics - internal close listener becomes cancellable scoped waiters", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      let canceledCompletions = 0
      const removed = yield* connection.closed.pipe(
        Effect.tap(() => Effect.sync(() => canceledCompletions++)),
        Effect.forkChild
      )
      yield* Fiber.interrupt(removed)
      const first = yield* connection.closed.pipe(Effect.forkChild)
      const second = yield* connection.closed.pipe(Effect.forkChild)
      yield* connection.close
      expect(yield* Fiber.join(first)).toEqual(Option.none())
      expect(yield* Fiber.join(second)).toEqual(Option.none())
      expect(canceledCompletions).toBe(0)
      expect(yield* connection.closed).toEqual(Option.none())
    })))

  it.live("basics - rtt rejects disconnected and closed states", () =>
    broker((server) =>
      Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect(yield* connection.rtt).toBeGreaterThanOrEqual(0)
        const disconnected = yield* connection.changes.pipe(
          Stream.filter((state) => state.state === "Reconnecting"),
          Stream.mapEffect(() => connection.rtt.pipe(Effect.flip)),
          Stream.runHead,
          Effect.forkChild
        )
        const stopping = yield* server.stop.pipe(Effect.forkChild)
        expect(Option.getOrThrow(yield* Fiber.join(disconnected)).code).toBe("disconnected")
        yield* Fiber.join(stopping)
        yield* connection.closed
        expect((yield* connection.rtt.pipe(Effect.flip)).code).toBe("closed")
      }), { maxReconnectAttempts: 1, reconnectTimeWait: 750, reconnectJitter: 0 }))

  it.live.each([false, true])(
    "basics - local initial connection fails, infoSent=%s",
    (infoSent) =>
      Effect.gen(function*() {
        const peer = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
                const server = createServer((socket) => {
                  socket.on("error", () => undefined)
                  socket.end(
                    "INFO {\"server_id\":\"FAKE\",\"server_name\":\"FAKE\",\"version\":\"2.15.0\",\"proto\":1,\"go\":\"test\",\"host\":\"127.0.0.1\",\"port\":4222,\"headers\":true,\"max_payload\":1048576}\r\n"
                  )
                })
                server.once("error", reject)
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address()
                  if (address === null || typeof address === "string") return reject(new Error("Peer port is absent"))
                  const close = () =>
                    new Promise<void>((resolve, reject) =>
                      server.close((error) =>
                        error && !error.message.includes("not running") ? reject(error) : resolve()
                      )
                    )
                  resolve({ port: address.port, close })
                })
              }),
            catch: (cause) => new Error("Cannot create failing TCP peer", { cause })
          }),
          (peer) => Effect.promise(peer.close)
        )
        if (!infoSent) yield* Effect.promise(peer.close)
        const error = yield* NATSConnection.NATSConnection.pipe(
          Effect.provide(
            NATSConnection.layerNode({ servers: "127.0.0.1:" + peer.port, reconnect: false, timeout: 1000 })
          ),
          Effect.flip
        )
        expect(error._tag).toBe("NATSConnectionError")
      }).pipe(Effect.scoped)
  )
  it.live("basics - pubsub and subscriptions iterate", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const sub = yield* connection.subscribe(subject)
      const collected = yield* sub.stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* connection.publish(subject, "world")
      const messages = yield* Fiber.join(collected)
      expect(messages).toHaveLength(1)
      expect(yield* messages[0].string).toBe("world")
      expect(yield* sub.getProcessed).toBe(1)
      expect(yield* sub.isClosed).toBe(true)
    })))

  it.live.each([false, true])(
    "basics - requests preserve binary replies, noMux=%s",
    (noMux) =>
      live(Effect.gen(function*() {
        const connection = yield* echo
        const response = yield* connection.request(subject, Uint8Array.of(1234), { noMux })
        expect(response.data).toEqual(Uint8Array.of(1234))
      }))
  )

  it.live("basics - server version minimum feature requirements", () =>
    live(Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const api = JetStreamApi.make(connection)
      yield* api.requireVersion("core minimum", [2, 8, 2])
      yield* api.requireVersion("pull max bytes", [2, 8, 3])
      const error = yield* api.requireVersion("future major", [3, 0, 0]).pipe(Effect.flip)
      expect(error.reason).toBe("future major requires NATS server 3.0.0")
    })))
})
