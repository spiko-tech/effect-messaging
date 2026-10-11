import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const serverInfo = {
  server_id: "test",
  server_name: "test",
  version: "2.15.0",
  go: "test",
  host: "test",
  port: 4222,
  proto: 1,
  max_payload: 1024,
  client_id: 1,
  headers: true
}

const harness = Effect.gen(function*() {
  const commands = yield* Queue.unbounded<{ readonly server: string; readonly text: string }>()
  const sessions: Array<{
    readonly server: string
    readonly incoming: Queue.Queue<Uint8Array, Socket.SocketError>
    readonly upgrade: () => number
  }> = []
  let respond = true
  let holdPublish: Deferred.Deferred<void> | undefined
  let greeting: object = serverInfo
  const factory: NATSConnection.SocketFactory = (server) =>
    Effect.gen(function*() {
      const incoming = yield* Queue.make<Uint8Array, Socket.SocketError>()
      let upgrades = 0
      sessions.push({ server, incoming, upgrade: () => upgrades })
      Queue.offerUnsafe(incoming, encoder.encode("INFO " + JSON.stringify(greeting) + "\r\n"))
      const write: Socket.Writer["write"] = (chunk) =>
        Effect.gen(function*() {
          if (Socket.isCloseEvent(chunk)) return
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          yield* Queue.offer(commands, { server, text })
          if (text === "PING\r\n" && respond) Queue.offerUnsafe(incoming, encoder.encode("PONG\r\n"))
          if (text.startsWith("PUB ") && holdPublish !== undefined) yield* Deferred.await(holdPublish)
        })
      return Socket.make({
        reader: Effect.gen(function*() {
          yield* Effect.addFinalizer(() =>
            Queue.fail(
              incoming,
              new Socket.SocketError({
                reason: new Socket.SocketReadError({ cause: new Error("Test socket closed") })
              })
            )
          )
          return {
            pull: Queue.take(incoming).pipe(Effect.map((chunk) => [chunk] as const)),
            upgrade: () =>
              Effect.sync(() => {
                upgrades++
              })
          }
        }),
        writer: Effect.succeed({
          write,
          writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
        })
      })
    })
  return {
    factory,
    sessions,
    commands,
    setRespond: (value: boolean) => {
      respond = value
    },
    setGreeting: (value: object) => {
      greeting = value
    },
    holdPublish: (barrier: Deferred.Deferred<void>) => {
      holdPublish = barrier
    }
  }
})

describe("native connection state machine with a controllable Effect socket", () => {
  it.effect("sends heartbeats once per configured interval and closes stale sessions", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "first:4222",
        pingInterval: 100,
        maxPingOut: 2,
        reconnect: false
      })
      yield* Queue.take(peer.commands)
      expect((yield* Queue.take(peer.commands)).text).toBe("PING\r\n")
      peer.setRespond(false)
      yield* TestClock.adjust(100)
      expect((yield* Queue.take(peer.commands)).text).toBe("PING\r\n")
      yield* TestClock.adjust(100)
      expect((yield* Queue.take(peer.commands)).text).toBe("PING\r\n")
      yield* TestClock.adjust(100)
      expect(Option.getOrThrow(yield* connection.closed).code).toBe("stale_connection")
    }).pipe(Effect.scoped))

  it.effect("server-pool replacement preserves the identity of the live socket", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "first:4222",
        noRandomize: true,
        reconnectTimeWait: 0,
        reconnectJitter: 0
      })
      yield* connection.setServers(["second:4222"])
      expect(yield* connection.getServer).toBe("nats://first:4222")
      yield* connection.reconnect
      expect(yield* connection.getServer).toBe("nats://second:4222")
      expect(peer.sessions.map((session) => session.server)).toEqual(["nats://first:4222", "nats://second:4222"])
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("uses the reconnect selection handler and passes complete server metadata", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      let calls = 0
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: ["first:4222", "second:4333"],
        noRandomize: true,
        reconnectTimeWait: 0,
        reconnectJitter: 0,
        reconnectToServer: (pool) => {
          calls++
          expect(pool[1]?.hostname).toBe("second")
          expect(pool[1]?.port).toBe(4333)
          return Option.fromNullishOr(pool[calls === 1 ? 1 : 0])
        }
      })
      expect(yield* connection.getServer).toBe("nats://second:4333")
      yield* connection.reconnect
      expect(yield* connection.getServer).toBe("nats://first:4222")
      expect(calls).toBe(2)
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("rejects a reconnect handler selecting a server outside the pool", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const failure = yield* NATSConnection.make(peer.factory, {
        servers: "first:4222",
        reconnectToServer: (pool) =>
          Option.fromNullishOr(pool[0]).pipe(
            Option.map((server) => ({ ...server, listen: "nats://foreign:4222" }))
          )
      }).pipe(Effect.flip)
      expect(failure.code).toBe("reconnect_handler")
      expect(peer.sessions).toHaveLength(0)
    }).pipe(Effect.scoped))

  it.effect("TLS-disabled policy rejects a server requiring encryption without upgrading", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.setGreeting({ ...serverInfo, tls_required: true })
      const failure = yield* NATSConnection.make(peer.factory, {
        servers: "first:4222",
        tls: false,
        reconnect: false
      }).pipe(Effect.flip)
      expect(failure.code).toBe("tls_error")
      expect(peer.sessions[0]?.upgrade()).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("a TLS URL upgrades an INFO-first connection even when TLS is optional", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.setGreeting({ ...serverInfo, tls_available: true })
      const connection = yield* NATSConnection.make(peer.factory, { servers: "tls://first:4222" })
      expect(peer.sessions[0]?.upgrade()).toBe(1)
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("removes disappeared discovered servers while retaining configured seeds", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.setGreeting({ ...serverInfo, connect_urls: ["first:4222", "second:4222"] })
      const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
      expect((yield* connection.getServers).map((server) => server.listen)).toEqual([
        "nats://first:4222",
        "nats://second:4222"
      ])
      const status = yield* connection.status
      const update = yield* status.pipe(
        Stream.filter((event) => event.type === "update"),
        Stream.runHead,
        Effect.forkChild
      )
      yield* connection.flush
      yield* Queue.offer(
        Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming,
        encoder.encode("INFO {\"connect_urls\":[\"first:4222\"]}\r\n")
      )
      const event = Option.getOrThrow(yield* Fiber.join(update))
      expect(event.type).toBe("update")
      if (event.type === "update") expect(event.deleted).toEqual(["nats://second:4222"])
      expect((yield* connection.getServers).map((server) => server.listen)).toEqual(["nats://first:4222"])
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("retains the fatal closed state through repeated explicit close calls", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
      yield* Queue.offer(
        Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming,
        encoder.encode("INVALID opcode\r\n")
      )
      expect(Option.getOrThrow(yield* connection.closed).code).toBe("protocol_error")
      yield* connection.close
      yield* connection.close
      expect((yield* connection.state).error?.code).toBe("protocol_error")
    }).pipe(Effect.scoped))

  it.effect.each([
    { label: "message", options: { maxPendingMessages: 1 } },
    { label: "byte", options: { maxPendingBytes: 4 } }
  ])(
    "fails a slow subscription at its configured $label budget while preserving the connection",
    ({ options }) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
        const subscription = yield* connection.subscribe("events", options)
        const id = yield* subscription.getID
        yield* connection.flush
        yield* Queue.offer(
          Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming,
          encoder.encode(
            `MSG events ${id} 4\r\none!\r\nMSG events ${id} 4\r\ntwo!\r\n`
          )
        )
        expect(Option.getOrThrow(yield* subscription.closed).reason).toContain("limit exceeded")
        yield* connection.flush
        expect(yield* connection.isClosed).toBe(false)
        yield* connection.close
      }).pipe(Effect.scoped)
  )

  it.effect.each([
    { label: "commands", options: { maxPendingCommands: 1 } },
    { label: "bytes", options: { maxBufferedBytes: 32 } }
  ])(
    "enforces the outbound $label budget while a transport write is suspended",
    ({ options }) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222", ...options })
        const barrier = yield* Deferred.make<void>()
        peer.holdPublish(barrier)
        yield* connection.publish("events", "first")
        yield* Stream.fromQueue(peer.commands).pipe(
          Stream.filter((command) => command.text.startsWith("PUB ")),
          Stream.runHead
        )
        yield* connection.publish("events", "second")
        const failure = yield* connection.publish("events", "third").pipe(Effect.flip)
        expect(failure.code).toBe("buffer_limit")
        yield* connection.close
      }).pipe(Effect.scoped)
  )

  it.effect.each([undefined, true, false])(
    "checks header capability for traceOnly=%s",
    (traceOnly) =>
      Effect.gen(function*() {
        const peer = yield* harness
        peer.setGreeting({ ...serverInfo, headers: false })
        const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
        if (traceOnly === undefined) yield* connection.publish("events", "plain")
        else {
          const failure = yield* connection.publish("events", "traced", { traceOnly }).pipe(Effect.flip)
          expect(failure.code).toBe("unsupported")
        }
        yield* connection.close
      }).pipe(Effect.scoped)
  )

  it.effect("validates message JSON with Schema and decodes service metadata dates", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
      const subscription = yield* connection.subscribe("events", { max: 1 })
      const id = yield* subscription.getID
      const headers = encoder.encode(
        "NATS/1.0\r\nNats-Request-Info: {\"acc\":\"test\",\"rtt\":10,\"start\":\"2026-10-11T12:00:00Z\",\"stop\":\"\"}\r\n\r\n"
      )
      const payload = encoder.encode("{\"value\":42}")
      const command = encoder.encode(`HMSG events ${id} ${headers.length} ${headers.length + payload.length}\r\n`)
      const frame = new Uint8Array(command.length + headers.length + payload.length + 2)
      frame.set(command)
      frame.set(headers, command.length)
      frame.set(payload, command.length + headers.length)
      frame.set([13, 10], frame.length - 2)
      yield* Queue.offer(Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming, frame)
      const message = Option.getOrThrow(yield* subscription.stream.pipe(Stream.runHead))
      expect(message.size).toBe(6 + headers.length + payload.length)
      expect(yield* message.decode(Schema.Struct({ value: Schema.Number }))).toEqual({ value: 42 })
      expect((yield* message.decode(Schema.Struct({ value: Schema.String })).pipe(Effect.flip))._tag)
        .toBe("NATSMessageError")
      const metadata = Option.getOrThrow(yield* message.requestInfo)
      expect(metadata.acc).toBe("test")
      expect(metadata.start).toEqual(new Date("2026-10-11T12:00:00Z"))
      expect(metadata.stop).toBe("")
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("unsubscribes a callback that throws again while reporting its first failure", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
      const subscription = yield* connection.subscribe("events", {
        callback: () => {
          throw new Error("Callback failed")
        }
      })
      const id = yield* subscription.getID
      yield* Queue.offer(
        Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming,
        encoder.encode(`MSG events ${id} 4\r\none!\r\n`)
      )
      expect(Option.getOrThrow(yield* subscription.closed).reason).toBe("Subscription callback failed")
      const unsubscribe = Option.getOrThrow(
        yield* Stream.fromQueue(peer.commands).pipe(
          Stream.filter((command) => command.text === `UNSUB ${id}\r\n`),
          Stream.runHead
        )
      )
      expect(unsubscribe.server).toBe("nats://first:4222")
      yield* connection.flush
      yield* connection.close
    }).pipe(Effect.scoped))

  it.effect("permits an Effect callback to drain its own subscription without waiting on itself", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "first:4222" })
      const finished = yield* Deferred.make<void>()
      const subscription: NATSSubscription.NATSSubscription = yield* connection.subscribe("events", {
        callback: (_error, message) =>
          Effect.gen(function*() {
            if (Option.isNone(message)) return
            yield* subscription.drain
            yield* Deferred.succeed(finished, undefined)
          })
      })
      const id = yield* subscription.getID
      yield* Queue.offer(
        Option.getOrThrow(Option.fromNullishOr(peer.sessions[0])).incoming,
        encoder.encode(`MSG events ${id} 4\r\none!\r\n`)
      )
      yield* Deferred.await(finished)
      expect(yield* subscription.isClosed).toBe(true)
      yield* connection.close
    }).pipe(Effect.scoped))
})
