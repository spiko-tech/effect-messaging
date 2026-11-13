import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schedule } from "effect"
import * as Fs from "node:fs"
import * as Net from "node:net"
import * as Tls from "node:tls"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import { expectFailure } from "./assertions.ts"
import { broker, decode, encode } from "./dependencies.ts"

// Public test-only certificate/key, never used outside this loopback TLS fixture.
const certificate = Fs.readFileSync(new URL("./fixtures/tls-cert.pem", import.meta.url))
const key = Fs.readFileSync(new URL("./fixtures/tls-key.pem", import.meta.url))

const tlsProxy = Effect.fnUntraced(function*(requestClientCertificate = false) {
  const sockets = new Set<Net.Socket>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const server = Tls.createServer({
        cert: certificate,
        key,
        ...(requestClientCertificate ? { requestCert: true, rejectUnauthorized: true, ca: certificate } : {})
      }, (socket) => {
        const upstream = Net.createConnection({ host: broker.hostname, port: broker.port })
        sockets.add(upstream)
        upstream.on("close", () => {
          sockets.delete(upstream)
          socket.destroy()
        })
        socket.on("close", () => upstream.destroy())
        upstream.on("error", () => socket.destroy())
        socket.on("error", () => upstream.destroy())
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      server.on("connection", (socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
      })
      server.on("tlsClientError", () => {})
      return server
    }),
    (server) =>
      Effect.promise(() =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        })
      )
  )
  yield* Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once("error", failed)
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", failed)
        resolve()
      })
    })
  )
  const address = server.address()
  if (address === null || typeof address === "string") return yield* Effect.die("Missing TLS fixture address")
  return address.port
})

describe("AMQP TLS transport", () => {
  it.live("C-L02: confirms four concurrent publishes through verified TLS and compares every payload", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy()
      const connection = yield* AMQPNodeConnection.make({
        ...broker,
        hostname: "127.0.0.1",
        port,
        tls: { ca: certificate, servername: "localhost" },
        frameMax: 8192,
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const bodies = Array.from({ length: 4 }, (_, i) => encode(`${i}: verified concurrent TLS `.repeat(500)))
      yield* Effect.forEach(bodies, (body) => channel.sendToQueue(queue, body), { concurrency: 4 })
      const received: Array<Uint8Array> = []
      for (let i = 0; i < 4; i++) {
        const message = yield* channel.get(queue)
        expect(Option.isSome(message)).toBe(true)
        if (Option.isSome(message)) {
          received.push(message.value.content)
          yield* channel.ack(message.value)
        }
      }
      expect(received.map(decode).sort()).toEqual(bodies.map(decode).sort())
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("publishes and settles through verified TLS before and after connection recovery", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy()
      const connection = yield* AMQPNodeConnection.make({
        ...broker,
        hostname: "127.0.0.1",
        port,
        tls: { ca: certificate, servername: "localhost" },
        frameMax: 8192,
        retryConnectionSchedule: Schedule.recurs(1)
      })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const body = encode("verified TLS payload ".repeat(500))
      yield* channel.sendToQueue(queue, body)
      const first = yield* channel.get(queue)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) {
        expect(first.value.content).toEqual(body)
        yield* channel.ack(first.value)
      }
      yield* connection.reconnect
      yield* channel.sendToQueue(queue, encode("after TLS reconnect"))
      const next = yield* channel.get(queue)
      expect(Option.isSome(next)).toBe(true)
      if (Option.isSome(next)) {
        expect(decode(next.value.content)).toBe("after TLS reconnect")
        yield* channel.ack(next.value)
      }
    }).pipe(Effect.scoped))

  it.live("rejects an untrusted TLS certificate without exposing connection credentials", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy()
      const secret = "test-only-tls-password-must-not-appear"
      const exit = yield* AMQPNodeConnection.make({
        hostname: "127.0.0.1",
        port,
        password: secret,
        tls: { servername: "localhost" },
        retryConnectionSchedule: Schedule.recurs(0)
      }).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret)
    }).pipe(Effect.scoped))

  it.live("rejects a trusted certificate for a different server identity", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy()
      const exit = yield* AMQPNodeConnection.make({
        hostname: "127.0.0.1",
        port,
        tls: { ca: certificate, servername: "wrong.example.invalid" },
        retryConnectionSchedule: Schedule.recurs(0)
      }).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
    }).pipe(Effect.scoped))

  it.live("publishes through mutually authenticated TLS with a trusted client certificate", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy(true)
      const connection = yield* AMQPNodeConnection.make({
        ...broker,
        hostname: "127.0.0.1",
        port,
        tls: { ca: certificate, cert: certificate, key, servername: "localhost" },
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const channel = yield* connection.createChannel({ confirm: true })
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.sendToQueue(queue, encode("mutual TLS"))
      const message = yield* channel.get(queue)
      expect(Option.isSome(message)).toBe(true)
      if (Option.isSome(message)) {
        expect(decode(message.value.content)).toBe("mutual TLS")
        yield* channel.ack(message.value)
      }
    }).pipe(Effect.scoped))

  it.live("fails when the TLS server requires a client certificate and none is supplied", () =>
    Effect.gen(function*() {
      const port = yield* tlsProxy(true)
      const exit = yield* AMQPNodeConnection.make({
        ...broker,
        hostname: "127.0.0.1",
        port,
        tls: { ca: certificate, servername: "localhost" },
        retryConnectionSchedule: Schedule.recurs(0)
      }).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
    }).pipe(Effect.scoped))
})
