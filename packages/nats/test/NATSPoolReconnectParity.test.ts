import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import { makeServer } from "./server.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const info = {
  server_id: "pool",
  server_name: "pool",
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
  const attempts = yield* Queue.unbounded<{ server: string; time: number }>()
  const sessions: Array<{ incoming: Queue.Queue<Uint8Array, Socket.SocketError>; commands: Array<string> }> = []
  let greeting: object = info
  let respond = true
  let handshakeOnly = false
  let unavailable = false
  let failures = 0
  const error = new Socket.SocketError({
    reason: new Socket.SocketReadError({ cause: new Error("peer disconnected") })
  })
  const factory: NATSConnection.SocketFactory = (server) =>
    Effect.gen(function*() {
      yield* Queue.offer(attempts, { server, time: yield* Clock.currentTimeMillis })
      if (unavailable || failures-- > 0) return yield* error
      const incoming = yield* Queue.make<Uint8Array, Socket.SocketError>()
      const commands: Array<string> = []
      sessions.push({ incoming, commands })
      Queue.offerUnsafe(incoming, encoder.encode("INFO " + JSON.stringify(greeting) + "\r\n"))
      const write: Socket.Writer["write"] = (chunk) =>
        Effect.sync(() => {
          if (Socket.isCloseEvent(chunk)) return
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          commands.push(text)
          if (
            respond && text === "PING\r\n" &&
            (!handshakeOnly || commands.filter((command) => command === text).length === 1)
          ) {
            Queue.offerUnsafe(incoming, encoder.encode("PONG\r\n"))
          }
        })
      return Socket.make({
        reader: Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Queue.fail(incoming, error))
          return {
            pull: Queue.take(incoming).pipe(Effect.map((bytes) => [bytes] as const)),
            upgrade: () => Effect.void
          }
        }),
        writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
      })
    })
  return {
    factory,
    attempts,
    sessions,
    greeting: (value: object) => {
      greeting = { ...info, ...value }
    },
    respond: (value: boolean) => {
      respond = value
    },
    handshakeOnly: () => {
      handshakeOnly = true
    },
    unavailable: () => {
      unavailable = true
    },
    failures: (value: number) => {
      failures = value
    },
    send: (wire: string) =>
      Queue.offer(Option.getOrThrow(Option.fromNullishOr(sessions.at(-1))).incoming, encoder.encode(wire)),
    disconnect: () => Queue.fail(Option.getOrThrow(Option.fromNullishOr(sessions.at(-1))).incoming, error)
  }
})
const statuses = (connection: NATSConnection.NATSConnection) =>
  connection.status.pipe(
    Effect.flatMap(Stream.runCollect),
    Effect.forkChild({ startImmediately: true })
  )

describe("official server pool and reconnect public laws", () => {
  it.effect.each([false, true])(
    "default reconnect jitter uses the configured TLS policy=%s budget",
    (tls) =>
      Effect.gen(function*() {
        const peer = yield* harness
        if (tls) peer.greeting({ tls_available: true })
        const connection = yield* NATSConnection.make(peer.factory, {
          servers: "seed:4222",
          ...(tls ? { tls: {} } : {}),
          maxReconnectAttempts: 1,
          reconnectTimeWait: 100,
          reconnectJitter: 50,
          reconnectJitterTLS: 150
        })
        const first = yield* Queue.take(peer.attempts)
        peer.unavailable()
        yield* peer.disconnect()
        yield* TestClock.adjust(250)
        const retry = yield* Queue.take(peer.attempts)
        const delay = retry.time - first.time
        expect(delay).toBeGreaterThanOrEqual(100)
        expect(delay).toBeLessThanOrEqual(tls ? 250 : 150)
        expect(Option.isSome(yield* connection.closed)).toBe(true)
      }).pipe(Effect.scoped)
  )
  it.effect("a transport factory applies endpoint conversion to configured and discovered servers", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.greeting({ connect_urls: ["gossip:4333/path"] })
      const converted: Array<string> = []
      const connection = yield* NATSConnection.make((server, metadata) => {
        converted.push(server.replace(/^nats:/, "x:"))
        return peer.factory(server, metadata)
      }, { servers: "seed:4222", noRandomize: true, reconnectTimeWait: 0, reconnectJitter: 0 })
      yield* connection.reconnect
      expect(converted).toEqual(["x://seed:4222", "x://gossip:4333/path"])
    }).pipe(Effect.scoped))
  it.effect("three stale sessions reconnect without closing the logical client", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.handshakeOnly()
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "seed:4222",
        pingInterval: 100,
        maxPingOut: 2,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 0,
        reconnectJitter: 0
      })
      const events = yield* statuses(connection)
      for (let step = 0; step < 9; step++) yield* TestClock.adjust(100)
      expect(peer.sessions).toHaveLength(4)
      expect(yield* connection.isClosed).toBe(false)
      yield* connection.close
      expect((yield* Fiber.join(events)).filter((event) => event.type === "staleConnection")).toHaveLength(3)
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.scoped))
  it.effect.each([{ servers: ["127.0.0.1:4222"] }, { servers: ["h:1", "h:2"] }])(
    "configured pool entries retain order and are never gossiped %j",
    ({ servers }) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, { servers, noRandomize: true })
        const pool = yield* connection.getServers
        expect(pool.map((server) => server.listen)).toEqual(servers.map((server) => "nats://" + server))
        expect(pool.every((server) => !server.gossiped)).toBe(true)
        expect(yield* connection.getServer).toBe(pool[0].listen)
      }).pipe(Effect.scoped)
  )
  it.effect.each(
    [
      ["localhost:80", 80],
      ["localhost:443", 443],
      ["localhost:201", 201],
      ["localhost", 4222],
      ["localhost/foo", 4222],
      ["localhost:2342/foo", 2342],
      ["[2001:db8:4006:812::200e]:8080", 8080],
      ["::1", 4222]
    ] as const
  )("normalizes endpoint port %s to %s", ([server, port]) =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: server })
      expect((yield* connection.getServers)[0].port).toBe(port)
    }).pipe(Effect.scoped))
  it.effect.each(
    [["hostname", "hostname"], ["hostname:40", "hostname"], ["::ffff:35.234.43.228", "::ffff:23ea:2be4"]] as const
  )(
    "classifies endpoint hostname through public metadata %s",
    ([server, hostname]) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, { servers: server })
        expect((yield* connection.getServers)[0].hostname).toBe(hostname)
      }).pipe(Effect.scoped)
  )
  it.effect("randomizes initial and replacement pools while preserving all configured endpoints", () =>
    Effect.gen(function*() {
      const servers = ["a:1", "b:2", "c:3", "d:4", "e:5", "f:6", "g:7", "h:8"]
      const initial = new Set<string>()
      const replacements = new Set<string>()
      for (let trial = 0; trial < 20; trial++) {
        yield* Effect.scoped(Effect.gen(function*() {
          const peer = yield* harness
          const connection = yield* NATSConnection.make(peer.factory, { servers })
          initial.add((yield* connection.getServers).map((server) => server.listen).join(","))
          yield* connection.setServers(servers)
          const pool = yield* connection.getServers
          expect(pool.map((server) => server.listen).sort()).toEqual(servers.map((server) => "nats://" + server).sort())
          replacements.add(pool.map((server) => server.listen).join(","))
        }))
      }
      expect(initial.size).toBeGreaterThan(1)
      expect(replacements.size).toBeGreaterThan(1)
    }))
  it.effect("gossip shuffles discovered endpoints while retaining the active seed at the head", () =>
    Effect.gen(function*() {
      const orders = new Set<string>()
      const connect_urls = ["a:2", "b:3", "c:4", "d:5", "e:6", "f:7", "g:8", "h:9"]
      for (let trial = 0; trial < 20; trial++) {
        yield* Effect.scoped(Effect.gen(function*() {
          const peer = yield* harness
          peer.greeting({ connect_urls })
          const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:1" })
          const pool = yield* connection.getServers
          expect(pool[0].listen).toBe("nats://seed:1")
          expect(pool.slice(1).every((server) => server.gossiped)).toBe(true)
          orders.add(pool.slice(1).map((server) => server.listen).join(","))
        }))
      }
      expect(orders.size).toBeGreaterThan(1)
    }))
  it.effect("explicitly configured discovered endpoints survive later gossip deletion", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      peer.greeting({ connect_urls: ["discovered:4222"] })
      const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222", noRandomize: true })
      yield* connection.setServers(["seed:4222", "discovered:4222"])
      expect((yield* connection.getServers).every((server) => !server.gossiped)).toBe(true)
      yield* peer.send("INFO {\"connect_urls\":[]}\r\n")
      yield* connection.flush
      expect(yield* connection.getServers).toHaveLength(2)
    }).pipe(Effect.scoped))
  it.effect("healthy heartbeats report pending pings and stop after explicit close", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { servers: "seed:4222", pingInterval: 100 })
      const events = yield* statuses(connection)
      for (let step = 0; step < 4; step++) yield* TestClock.adjust(100)
      yield* connection.close
      const collected = yield* Fiber.join(events)
      expect(collected.filter((event) => event.type === "ping").length).toBeGreaterThanOrEqual(3)
      expect(yield* connection.closed).toEqual(Option.none())
      const commands = peer.sessions[0].commands.length
      yield* TestClock.adjust(1000)
      expect(peer.sessions[0].commands).toHaveLength(commands)
    }).pipe(Effect.scoped))
  it.effect("heartbeat pongs recover from two missed intervals before the stale threshold", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "seed:4222",
        pingInterval: 100,
        maxPingOut: 3
      })
      const events = yield* statuses(connection)
      peer.respond(false)
      yield* TestClock.adjust(100)
      yield* TestClock.adjust(100)
      yield* peer.send("PONG\r\nPONG\r\n")
      peer.respond(true)
      yield* connection.flush
      yield* TestClock.adjust(100)
      expect(yield* connection.isClosed).toBe(false)
      yield* connection.close
      const pings = (yield* Fiber.join(events)).filter((event) => event.type === "ping")
      expect(pings.map((event) => event.type === "ping" ? event.pendingPings : 0)).toEqual([1, 2, 1])
    }).pipe(Effect.scoped))
  it.effect.each([false, true])(
    "reconnect retirement emits one disconnect and honors reconnect=%s",
    (reconnect) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory, {
          servers: "seed:4222",
          reconnect,
          maxReconnectAttempts: 3,
          reconnectTimeWait: 100,
          reconnectJitter: 0
        })
        const events = yield* statuses(connection)
        peer.unavailable()
        yield* peer.disconnect()
        for (let step = 0; step < 4; step++) yield* TestClock.adjust(100)
        expect(Option.isSome(yield* connection.closed)).toBe(true)
        const collected = yield* Fiber.join(events)
        expect(collected.filter((event) => event.type === "disconnect")).toHaveLength(1)
        expect(collected.filter((event) => event.type === "reconnecting")).toHaveLength(reconnect ? 3 : 0)
      }).pipe(Effect.scoped)
  )
  it.effect("closing an indefinitely reconnecting client cancels all future dials", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "seed:4222",
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
        reconnectJitter: 0
      })
      peer.unavailable()
      yield* peer.disconnect()
      for (let step = 0; step < 5; step++) yield* TestClock.adjust(100)
      yield* connection.close
      const attempts = yield* Queue.size(peer.attempts)
      expect(attempts).toBeGreaterThanOrEqual(6)
      yield* TestClock.adjust(1000)
      expect(yield* Queue.size(peer.attempts)).toBe(attempts)
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.scoped))
  it.effect.each(["initial", "reconnect"] as const)(
    "throwing server selection closes the %s attempt through a typed error",
    (mode) =>
      Effect.gen(function*() {
        const peer = yield* harness
        let calls = 0
        const effect = NATSConnection.make(peer.factory, {
          servers: "seed:4222",
          reconnectTimeWait: 0,
          reconnectJitter: 0,
          maxReconnectAttempts: -1,
          reconnectToServer: (pool) => {
            if (mode === "initial" || calls++ > 0) throw new Error("selection exploded")
            return Option.some(pool[0])
          }
        })
        if (mode === "initial") {
          const failure = yield* effect.pipe(Effect.flip)
          expect(failure.code).toBe("reconnect_handler")
          expect(peer.sessions).toHaveLength(0)
        } else {
          const connection = yield* effect
          yield* peer.disconnect()
          expect(Option.getOrThrow(yield* connection.closed).code).toBe("reconnect_handler")
        }
      }).pipe(Effect.scoped)
  )
  it.effect("an absent server selection uses the normal pool and a delayed selection defers the actual dial", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const fallback = yield* NATSConnection.make(peer.factory, {
        servers: "seed:4222",
        reconnectToServer: () => Option.none()
      })
      expect(yield* fallback.getServer).toBe("nats://seed:4222")
      yield* fallback.close
      const started = yield* Clock.currentTimeMillis
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "delayed:4222",
        reconnectToServer: (pool) => Option.some({ server: pool[0], delay: 500 })
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(499)
      expect(peer.sessions).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(connection)
      expect((yield* Queue.take(peer.attempts)).time).toBe(started)
      expect((yield* Queue.take(peer.attempts)).time).toBe(started + 500)
    }).pipe(Effect.scoped))
  it.effect("server-reported protocol errors reconnect three times without a fatal close", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "seed:4222",
        reconnectTimeWait: 0,
        reconnectJitter: 0,
        maxReconnectAttempts: -1
      })
      for (let count = 0; count < 3; count++) {
        const recovered = yield* connection.status.pipe(
          Effect.flatMap((events) => events.pipe(Stream.filter((event) => event.type === "reconnect"), Stream.runHead)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* peer.send("-ERR 'Unknown Protocol Operation'\r\n")
        yield* Fiber.join(recovered)
        expect(yield* connection.isClosed).toBe(false)
      }
      expect(peer.sessions).toHaveLength(4)
      yield* connection.close
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.scoped))
  it.live("waitOnFirstConnect retries until a stopped broker becomes available", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* server.stop
      let attempts = 0
      const restart = yield* Deferred.make<void>()
      const restarting = yield* Deferred.await(restart).pipe(Effect.andThen(server.start), Effect.forkChild)
      const connection = yield* Node.make({
        servers: server.url,
        waitOnFirstConnect: true,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 100,
        reconnectJitter: 0,
        reconnectDelayHandler: () => {
          attempts++
          if (attempts === 2) Deferred.doneUnsafe(restart, Effect.void)
          return 100
        }
      })
      expect(attempts).toBeGreaterThanOrEqual(2)
      yield* Fiber.join(restarting)
      yield* connection.flush
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("authentication timeouts retry and re-evaluate native Effect credentials", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "authorization { timeout: 0.02, token: \"hello\" }" })
      let calls = 0
      const connection = yield* Node.make({
        servers: server.url,
        waitOnFirstConnect: true,
        ignoreAuthErrorAbort: true,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 1,
        reconnectJitter: 0,
        authenticator: () =>
          Effect.gen(function*() {
            if (++calls <= 3) yield* Effect.sleep(100)
            return { auth_token: "hello" }
          })
      })
      expect(calls).toBeGreaterThanOrEqual(4)
      expect(yield* connection.isClosed).toBe(false)
      yield* connection.flush
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
