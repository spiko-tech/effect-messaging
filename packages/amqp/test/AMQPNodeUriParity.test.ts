import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Queue, Redacted, Schedule, Stream } from "effect"
import * as Net from "node:net"
import type * as AMQPConnection from "../src/AMQPConnection.ts"
import { AMQPProtocolError } from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"

// Codec is only the external peer's wire scaffolding; all expected URI values below are independent literals.
const tcpPeer = Effect.fnUntraced(function*(closeDuringHandshake = false, host = "127.0.0.1") {
  const methods = yield* Queue.unbounded<Codec.Method | Error>()
  const sockets = new Set<Net.Socket>()
  const peers = yield* Queue.unbounded<Net.Socket>()
  yield* Stream.fromQueue(peers).pipe(
    Stream.runForEach(Effect.fnUntraced(function*(socket) {
      const decoder = yield* Codec.makeFrameDecoder()
      const chunks = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      let protocolBytes = 0
      const reply = Effect.fnUntraced(function*(methodId: number, fields: Record<string, AMQPTypes.FieldValue> = {}) {
        socket.write(yield* Codec.encodeMethod(0, 10, methodId, fields))
      })
      socket.on(
        "data",
        (chunk) => Queue.offerUnsafe(chunks, typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      )
      socket.on("close", () => Queue.endUnsafe(chunks))
      yield* Stream.fromQueue(chunks).pipe(
        Stream.runForEach(Effect.fnUntraced(function*(chunk) {
          let bytes = chunk
          if (protocolBytes < 8) {
            const count = Math.min(bytes.length, 8 - protocolBytes)
            for (let i = 0; i < count; i++) {
              if (bytes[i] !== Codec.PROTOCOL_HEADER[protocolBytes + i]) {
                return yield* Effect.fail(new AMQPProtocolError({ reason: "Invalid protocol header" }))
              }
            }
            protocolBytes += count
            bytes = bytes.subarray(count)
            if (protocolBytes === 8) {
              yield* reply(10, {
                versionMajor: 0,
                versionMinor: 9,
                serverProperties: { product: "Loopback TCP peer" },
                mechanisms: "PLAIN",
                locales: "en_US"
              })
            }
          }
          yield* decoder.feed(
            bytes,
            Effect.fnUntraced(function*(frame) {
              if (frame.type !== 1) return true
              const method = yield* Codec.decodeMethod(frame.payload)
              yield* Queue.offer(methods, method)
              if (method.classId !== 10) {
                return yield* Effect.fail(new AMQPProtocolError({ reason: "Unexpected connection method" }))
              }
              switch (method.methodId) {
                case 11:
                  if (closeDuringHandshake) socket.end()
                  else yield* reply(30, { channelMax: 32, frameMax: 131072, heartbeat: 0 })
                  break
                case 40:
                  yield* reply(41)
                  break
                case 50:
                  yield* reply(51)
                  socket.end()
                  break
              }
              return true
            })
          )
        })),
        Effect.catch((error) =>
          Effect.gen(function*() {
            yield* Queue.offer(methods, error)
            socket.destroy()
          })
        ),
        Effect.forkScoped
      )
    })),
    Effect.forkScoped
  )
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Net.createServer((socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
        socket.on("error", (error) => Queue.offerUnsafe(methods, error))
        Queue.offerUnsafe(peers, socket)
      })
    ),
    (server) =>
      Effect.promise(() =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        })
      )
  )
  yield* Effect.tryPromise(() =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, host, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
  )
  const address = server.address()
  if (address === null || typeof address === "string") return yield* Effect.die("Missing TCP peer address")
  return { port: address.port, methods, server }
})

const nextMethod = Effect.fnUntraced(function*(methods: Queue.Queue<Codec.Method | Error>, methodId: number) {
  const method = yield* Queue.take(methods)
  if (method instanceof Error) return yield* Effect.die(method)
  expect(method.classId).toBe(10)
  expect(method.methodId).toBe(methodId)
  return method.fields
})

const transportOptions = {
  retryConnectionSchedule: Schedule.recurs(0),
  connectionTimeout: "1 second",
  shutdownTimeout: "1 second"
} satisfies AMQPConnection.AMQPConnectionOptions

const uriCases = [
  { name: "ordinary user and password", userinfo: "user:pass@", path: "/", plain: "\0user\0pass", vhost: "/" },
  { name: "encoded hash password", userinfo: "user:passw%23rd@", path: "/", plain: "\0user\0passw#rd", vhost: "/" },
  {
    name: "encoded username and password letters",
    userinfo: "user%61:%61pass@",
    path: "/",
    plain: "\0usera\0apass",
    vhost: "/"
  },
  { name: "lowercase encoded root slash", userinfo: "", path: "/%2f", plain: "\0guest\0guest", vhost: "/" },
  { name: "encoded space vhost", userinfo: "", path: "/my%20vhost", plain: "\0guest\0guest", vhost: "my vhost" },
  { name: "default guest and absent path", userinfo: "", path: "", plain: "\0guest\0guest", vhost: "/" },
  { name: "explicit root path", userinfo: "", path: "/", plain: "\0guest\0guest", vhost: "/" },
  { name: "encoded root slash", userinfo: "", path: "/%2F", plain: "\0guest\0guest", vhost: "/" },
  {
    name: "percent encoded delimiters and slash",
    userinfo: "user%3A%40%25:pass%3A%40%25%2F@",
    path: "/team%3A%40%25%2Fwork",
    plain: "\0user:@%\0pass:@%/",
    vhost: "team:@%/work"
  },
  {
    name: "decode percent escapes once",
    userinfo: "u%253A:p%2540@",
    path: "/%252F",
    plain: "\0u%3A\0p%40",
    vhost: "%2F"
  },
  { name: "explicit empty credentials", userinfo: ":@", path: "/", plain: "\0\0", vhost: "/" },
  { name: "empty username", userinfo: ":password@", path: "/", plain: "\0\0password", vhost: "/" },
  { name: "empty password", userinfo: "user:@", path: "/", plain: "\0user\0", vhost: "/" },
  // Current policy matches amqplib: an omitted password defaults to guest, not an empty password.
  { name: "username with omitted password", userinfo: "user@", path: "/", plain: "\0user\0guest", vhost: "/" },
  { name: "empty userinfo with omitted password", userinfo: "@", path: "/", plain: "\0\0guest", vhost: "/" },
  { name: "zero credentials are strings", userinfo: "0:0@", path: "/0", plain: "\u00000\u00000", vhost: "0" }
]

describe("AMQP Node URI parity at the TCP broker boundary", () => {
  it.live.each([
    { name: "blurble URL", uri: "blurble" },
    { name: "blurble protocol", uri: "blurble://guest:never-log@127.0.0.1:PORT/" },
    { name: "nonnumeric frameMax", uri: "amqp://guest:never-log@127.0.0.1:PORT/?frameMax=bad" },
    { name: "nonnumeric heartbeat", uri: "amqp://guest:never-log@127.0.0.1:PORT/?heartbeat=bad" },
    { name: "nonnumeric channelMax", uri: "amqp://guest:never-log@127.0.0.1:PORT/?channelMax=bad" },
    { name: "invalid percent username", uri: "amqp://%zz:never-log@127.0.0.1:PORT/" },
    { name: "invalid percent password", uri: "amqp://guest:never-log%zz@127.0.0.1:PORT/" },
    { name: "invalid percent vhost", uri: "amqp://guest:never-log@127.0.0.1:PORT/%zz" },
    { name: "unclosed IPv6 bracket", uri: "amqp://guest:never-log@[::1:PORT/" },
    { name: "invalid IPv6 host", uri: "amqp://guest:never-log@[not-ipv6]:PORT/" }
  ])("rejects $name permanently without dialing or leaking credentials", ({ uri }) =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer()
      let dials = 0
      peer.server.on("connection", () => dials++)
      for (
        const input of [uri.replace("PORT", String(peer.port)), Redacted.make(uri.replace("PORT", String(peer.port)))]
      ) {
        const exit = yield* AMQPNodeConnection.make(input, transportOptions).pipe(Effect.exit)
        expectFailure(exit, { _tag: "AMQPConnectionError", permanent: true })
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain("never-log")
      }
      expect(dials).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live("sends an explicit connection name in clientProperties", () =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer()
      const connection = yield* AMQPNodeConnection.make(
        // URL name is unsupported; this asserts only the public connectionName option, not query-name parity.
        `amqp://127.0.0.1:${peer.port}/?name=unsupported-query-name`,
        { ...transportOptions, connectionName: "explicit-connection-name" }
      )
      expect((yield* nextMethod(peer.methods, 11)).clientProperties).toEqual(
        expect.objectContaining({ connection_name: "explicit-connection-name" })
      )
      yield* connection.close
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live("connects using a bracketed IPv6 loopback URI when IPv6 is available", (context) =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer(false, "::1").pipe(Effect.catch((error) => {
        const cause = error.cause
        if (
          cause instanceof Error && "code" in cause &&
          (cause.code === "EAFNOSUPPORT" || cause.code === "EADDRNOTAVAIL" || cause.code === "ENETUNREACH")
        ) {
          return Effect.sync(() => context.skip("IPv6 loopback is unavailable on this host"))
        }
        return Effect.fail(error)
      }))
      const connection = yield* AMQPNodeConnection.make(`amqp://[::1]:${peer.port}/`, transportOptions)
      expect((yield* connection.state).state).toBe("Ready")
      expect((yield* nextMethod(peer.methods, 11)).response).toEqual(new TextEncoder().encode("\0guest\0guest"))
      yield* nextMethod(peer.methods, 31)
      expect((yield* nextMethod(peer.methods, 40)).virtualHost).toBe("/")
      yield* connection.close
      yield* nextMethod(peer.methods, 50)
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live.each(uriCases)("sends $name on the wire", ({ path, plain, userinfo, vhost }) =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer()
      const connection = yield* AMQPNodeConnection.make(
        `amqp://${userinfo}127.0.0.1:${peer.port}${path}`,
        transportOptions
      )
      expect((yield* connection.state).state).toBe("Ready")
      const startOk = yield* nextMethod(peer.methods, 11)
      expect(startOk.mechanism).toBe("PLAIN")
      // Compare the binary SASL response, including both NUL delimiters.
      expect(startOk.response).toEqual(new TextEncoder().encode(plain))
      yield* nextMethod(peer.methods, 31)
      expect((yield* nextMethod(peer.methods, 40)).virtualHost).toBe(vhost)
      yield* connection.close
      yield* nextMethod(peer.methods, 50)
      expect((yield* connection.state).state).toBe("Closed")
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live.each([
    { name: "URL query values", overrides: {}, expected: { channelMax: 7, frameMax: 8192, heartbeat: 9 } },
    {
      name: "explicit options override query values",
      overrides: { channelMax: 3, frameMax: 16384, heartbeat: 4 },
      expected: { channelMax: 3, frameMax: 16384, heartbeat: 4 }
    },
    {
      name: "zero options override nonzero query values",
      overrides: { channelMax: 0, frameMax: 0, heartbeat: 0 },
      expected: { channelMax: 32, frameMax: 131072, heartbeat: 0 }
    }
  ])("negotiates $name on the wire", ({ expected, overrides }) =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer()
      const connection = yield* AMQPNodeConnection.make(
        `amqp://127.0.0.1:${peer.port}/?frameMax=8192&channelMax=7&heartbeat=9`,
        { ...transportOptions, ...overrides }
      )
      yield* nextMethod(peer.methods, 11)
      expect(yield* nextMethod(peer.methods, 31)).toEqual(expected)
      expect((yield* nextMethod(peer.methods, 40)).virtualHost).toBe("/")
      yield* connection.close
      yield* nextMethod(peer.methods, 50)
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live("fails when the TCP peer closes during the handshake", () =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer(true)
      const exit = yield* AMQPNodeConnection.make(`amqp://127.0.0.1:${peer.port}/`, transportOptions).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
      expect((yield* nextMethod(peer.methods, 11)).mechanism).toBe("PLAIN")
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live("fails when a real TCP endpoint refuses the connection", () =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer()
      yield* Effect.promise(() => new Promise<void>((resolve) => peer.server.close(() => resolve())))
      const exit = yield* AMQPNodeConnection.make(`amqp://127.0.0.1:${peer.port}/`, transportOptions).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        expect(error).toEqual(expect.objectContaining({
          cause: expect.objectContaining({
            reason: expect.objectContaining({ cause: expect.objectContaining({ code: "ECONNREFUSED" }) })
          })
        }))
      }
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))
})
