import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeServer, prepareTLS } from "./server.ts"

const execute = promisify(execFile)
const info = {
  server_id: "script",
  server_name: "script",
  version: "2.15.0",
  go: "test",
  host: "test",
  port: 4222,
  proto: 1,
  max_payload: 1024,
  client_id: 1,
  headers: true
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const scripted = Effect.gen(function*() {
  const incoming = yield* Queue.make<Uint8Array, Socket.SocketError>()
  const commands = yield* Queue.unbounded<string>()
  let opens = 0
  let failOpens = false
  let upgrades = 0
  let respond = true
  let greeting: object = info
  const failure = new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error("peer error") }) })
  const factory: NATSConnection.SocketFactory = () =>
    Effect.gen(function*() {
      opens++
      if (failOpens) return yield* Effect.fail(failure)
      Queue.offerUnsafe(incoming, encoder.encode("INFO " + JSON.stringify(greeting) + "\r\n"))
      const write: Socket.Writer["write"] = (chunk) =>
        Effect.gen(function*() {
          if (Socket.isCloseEvent(chunk)) return
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          Queue.offerUnsafe(commands, text)
          if (text === "PING\r\n" && respond) Queue.offerUnsafe(incoming, encoder.encode("PONG\r\n"))
        })
      return Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(incoming).pipe(Effect.map((bytes) => [bytes] as const)),
          upgrade: () =>
            Effect.sync(() => {
              upgrades++
            })
        }),
        writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
      })
    })
  return {
    factory,
    incoming,
    commands,
    failure,
    opens: () => opens,
    upgrades: () => upgrades,
    setInfo: (update: object) => {
      greeting = { ...info, ...update }
    },
    stopResponding: () => {
      respond = false
      failOpens = true
    },
    stop: () =>
      Effect.sync(() => {
        failOpens = true
      }).pipe(Effect.andThen(Queue.fail(incoming, failure)))
  }
})
const tlsConfig = "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
const connect = (url: string, tls?: NATSOptions.NodeTlsOptions | false) =>
  Effect.scoped(
    Node.make({ servers: url, ...(tls === undefined ? {} : { tls }), reconnect: false, timeout: 1000 }).pipe(
      Effect.flatMap((connection) => connection.flush)
    )
  )

describe("official Node transport public laws", () => {
  it.effect("gossiped IP reconnects retain the original DNS identity in transport metadata", () =>
    Effect.gen(function*() {
      const peer = yield* scripted
      peer.setInfo({ tls_available: true, connect_urls: ["127.0.0.1:4233"] })
      const seen: Array<NATSOptions.Server> = []
      const connection = yield* NATSConnection.make((endpoint, metadata) =>
        Effect.suspend(() => {
          seen.push(metadata)
          return peer.factory(endpoint, metadata)
        }), { servers: "localhost:4222", noRandomize: true, reconnectTimeWait: 1, reconnectJitter: 0 })
      const discovered = (yield* connection.getServers).find((server) => server.gossiped)
      expect(discovered?.hostname).toBe("127.0.0.1")
      expect(discovered?.tlsName).toBe("localhost")
      const reconnecting = yield* connection.reconnect.pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(5)
      yield* Fiber.join(reconnecting)
      expect(seen[1]?.hostname).toBe("127.0.0.1")
      expect(seen[1]?.tlsName).toBe("localhost")
      yield* connection.close
    }).pipe(Effect.scoped))
  it.live("WebSocket broker restart reacquires transport and restores subscriptions", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "websocket { port: 8080, no_tls: true }" })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const sub = yield* connection.subscribe("node.websocket.restart", { max: 2 })
        yield* connection.publish("node.websocket.restart", "before")
        yield* connection.flush
        const retries = yield* connection.status.pipe(
          Effect.flatMap((statuses) =>
            statuses.pipe(
              Stream.filter((status) => status.type === "reconnecting"),
              Stream.take(6),
              Stream.runCollect
            )
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* server.stop
        yield* connection.changes.pipe(Stream.filter((state) => state.state === "Reconnecting"), Stream.runHead)
        expect(yield* Fiber.join(retries).pipe(Effect.timeout("5 seconds"))).toHaveLength(6)
        yield* server.start
        yield* connection.changes.pipe(
          Stream.filter((state) => state.state === "Connected"),
          Stream.runHead,
          Effect.timeout("5 seconds")
        )
        yield* connection.publish("node.websocket.restart", "after")
        yield* connection.flush
        expect(yield* sub.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
          .toEqual(["before", "after"])
      }).pipe(Effect.provide(NATSConnection.layerWebSocket({
        servers: server.websocketUrl,
        reconnectTimeWait: 1,
        reconnectJitter: 0,
        maxReconnectAttempts: -1
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.effect("stale transport retirement emits stale, disconnect and reconnecting statuses", () =>
    Effect.gen(function*() {
      const peer = yield* scripted
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "test:4222",
        pingInterval: 100,
        maxPingOut: 1,
        maxReconnectAttempts: 1,
        reconnectTimeWait: 1,
        reconnectJitter: 0
      })
      const events = yield* connection.status.pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.forkChild({ startImmediately: true })
      )
      peer.stopResponding()
      yield* TestClock.adjust(400)
      yield* connection.closed
      const types = (yield* Fiber.join(events)).map((event) => event.type)
      expect(types).toContain("staleConnection")
      expect(types).toContain("disconnect")
      expect(types).toContain("reconnecting")
      expect(peer.opens()).toBe(2)
    }).pipe(Effect.scoped))
  it.effect("default TLS policy negotiates available encryption without explicit TLS options", () =>
    Effect.gen(function*() {
      const peer = yield* scripted
      peer.setInfo({ tls_available: true })
      const connection = yield* NATSConnection.make(peer.factory, { servers: "test:4222" })
      expect(peer.upgrades()).toBe(1)
      yield* connection.flush
      yield* connection.close
    }).pipe(Effect.scoped))
  it.live.each([{}, { servers: "localhost" }, { servers: "localhost:4222" }, { servers: ["localhost"] }])(
    "connects with default host and server forms %j",
    (options) => Effect.scoped(Node.make(options).pipe(Effect.flatMap((connection) => connection.flush)))
  )
  it.live("Node publication and stream consumption update the processed count", () =>
    Effect.gen(function*() {
      const connection = yield* Node.make()
      const sub = yield* connection.subscribe("node.processed.count", { max: 1 })
      yield* connection.publish("node.processed.count")
      expect(yield* Stream.runCollect(sub.stream)).toHaveLength(1)
      expect(yield* sub.getProcessed).toBe(1)
    }).pipe(Effect.scoped))
  it.live.each(["ws://localhost:4222", "wss://localhost:4222"])(
    "rejects websocket URL in TCP adapter %s",
    (url) =>
      Effect.gen(function*() {
        const result = yield* Node.makeSocket(new URL(url)).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      })
  )
  it.live("reports refused initial connections as typed socket errors", () =>
    Effect.gen(function*() {
      const result = yield* Node.makeSocket(new URL("nats://127.0.0.1:7")).pipe(
        Effect.flatMap((socket) => socket.reader),
        Effect.scoped,
        Effect.result
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SocketError")
    }))
  it.effect("CONNECT reports package version and never serializes TLS material", () =>
    Effect.gen(function*() {
      const peer = yield* scripted
      peer.setInfo({ tls_available: true })
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "test:4222",
        tls: { key: "private key", cert: "certificate", caFile: "secret path" }
      })
      const command = yield* Stream.fromQueue(peer.commands).pipe(
        Stream.filter((text) => text.startsWith("CONNECT ")),
        Stream.runHead
      )
      const text = Option.getOrThrow(command)
      const payload = JSON.parse(text.slice(8))
      expect(payload.version).toBe("1.0.0-beta.0")
      expect(payload.tls_required).toBe(true)
      for (const key of ["tls", "key", "cert", "ca", "keyFile", "certFile", "caFile"]) {
        expect(payload[key]).toBeUndefined()
      }
      expect(text).not.toContain("private key")
      expect(text).not.toContain("secret path")
      yield* connection.close
    }).pipe(Effect.scoped))
  it.effect.each([false, true])(
    "socket failures terminate sessions and suppress retry when reconnect=%s",
    (reconnect) =>
      Effect.gen(function*() {
        const peer = yield* scripted
        const connection = yield* NATSConnection.make(peer.factory, {
          servers: "test:4222",
          reconnect,
          maxReconnectAttempts: 2,
          reconnectTimeWait: 50,
          reconnectJitter: 0
        })
        const events = yield* connection.status.pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.forkChild({ startImmediately: true })
        )
        yield* peer.stop()
        yield* TestClock.adjust(200)
        const failure = yield* connection.closed
        expect(Option.isSome(failure)).toBe(true)
        if (!reconnect) expect(Option.getOrThrow(failure).cause).toBe(peer.failure)
        const statuses = yield* Fiber.join(events)
        expect(statuses.filter((status) => status.type === "disconnect")).toHaveLength(1)
        expect(statuses.filter((status) => status.type === "reconnecting")).toHaveLength(reconnect ? 2 : 0)
        expect(peer.opens()).toBe(reconnect ? 3 : 1)
      }).pipe(Effect.scoped)
  )
  it.effect("reconnection delay and custom delay handler govern physical retry attempts", () =>
    Effect.gen(function*() {
      const peer = yield* scripted
      let calls = 0
      const connection = yield* NATSConnection.make(peer.factory, {
        servers: "test:4222",
        maxReconnectAttempts: 1,
        reconnectDelayHandler: () => {
          calls++
          return 500
        }
      })
      const connectedAt = yield* Clock.currentTimeMillis
      yield* peer.stop()
      yield* TestClock.adjust(499)
      expect(peer.opens()).toBe(1)
      yield* TestClock.adjust(1)
      yield* connection.closed
      expect(peer.opens()).toBe(2)
      expect(calls).toBe(1)
      expect((yield* Clock.currentTimeMillis) - connectedAt).toBe(500)
    }).pipe(Effect.scoped))
  it.live("invalid initial servers are discarded and the usable server delivers traffic", () =>
    Effect.gen(function*() {
      const connection = yield* Node.make({ servers: ["nats://127.0.0.1:7", "localhost:4222"], noRandomize: true })
      const sub = yield* connection.subscribe("node.valid.server", { max: 1 })
      yield* connection.publish("node.valid.server", "ok")
      expect(yield* Stream.runCollect(sub.stream)).toHaveLength(1)
      const servers = yield* connection.getServers
      expect(servers).toHaveLength(1)
      expect(servers[0].didConnect).toBe(true)
    }).pipe(Effect.scoped))
  it.live("unlimited reconnect attempts remain active until the broker returns", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      const connection = yield* Node.make({
        servers: server.url,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1,
        reconnectJitter: 0
      })
      const retried = yield* Deferred.make<void>()
      let retries = 0
      yield* connection.status.pipe(
        Effect.flatMap((statuses) =>
          Stream.runForEach(statuses, (status) => {
            if (status.type === "reconnecting" && ++retries === 6) return Deferred.succeed(retried, undefined)
            return Effect.void
          })
        ),
        Effect.forkChild
      )
      yield* server.stop
      yield* Deferred.await(retried).pipe(Effect.timeout("5 seconds"))
      expect(yield* connection.isClosed).toBe(false)
      yield* server.start
      yield* connection.changes.pipe(
        Stream.filter((state) => state.state === "Connected"),
        Stream.runHead,
        Effect.timeout("5 seconds")
      )
      yield* connection.flush
      expect(retries).toBeGreaterThanOrEqual(6)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("TLS availability upgrades automatically and explicit false permits plaintext", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "allow_non_tls: true\ntls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
      })
      expect((yield* connect(server.url).pipe(Effect.result))._tag).toBe("Failure")
      yield* connect(server.url, { caFile: join(server.directory, "server.crt") })
      yield* connect(server.url, false)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each([false, true])(
    "honors rejectUnauthorized=false with handshakeFirst=%s",
    (handshakeFirst) =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          prepare: prepareTLS,
          config: handshakeFirst ? tlsConfig.replace(" }", ", handshake_first: true }") : tlsConfig
        })
        yield* connect(server.url, { rejectUnauthorized: false, handshakeFirst })
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("rejects explicit TLS when the server has no TLS support", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      expect((yield* connect(server.url, {}).pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each(["keyFile", "certFile", "caFile"] as const)(
    "missing TLS %s fails through the typed channel",
    (field) =>
      Effect.gen(function*() {
        const server = yield* makeServer({ prepare: prepareTLS, config: tlsConfig })
        const result = yield* connect(server.url, { [field]: "/missing/nats-fixture.pem" }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live.each(["mismatch", "pem"] as const)(
    "invalid TLS %s fails through the typed channel",
    (kind) =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          prepare: async (directory) => {
            await prepareTLS(directory)
            await execute("openssl", ["genrsa", "-out", join(directory, "other.key"), "2048"])
          },
          config: tlsConfig
        })
        const result = yield* connect(server.url, {
          caFile: join(server.directory, "server.crt"),
          certFile: join(server.directory, "server.crt"),
          keyFile: join(server.directory, kind === "mismatch" ? "other.key" : "server.crt")
        }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("mutual TLS accepts direct byte PEM credentials", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config:
          "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\", ca_file: \"/fixture/server.crt\", verify: true }"
      })
      const material = yield* Effect.promise(async () => ({
        ca: await readFile(join(server.directory, "server.crt")),
        cert: await readFile(join(server.directory, "server.crt")),
        key: await readFile(join(server.directory, "server.key"))
      }))
      yield* connect(server.url, material)
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
