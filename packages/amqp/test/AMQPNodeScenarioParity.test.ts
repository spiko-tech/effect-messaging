import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Queue, Schedule, Stream } from "effect"
import * as Net from "node:net"
import type * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPError from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"

type Behavior = "ready" | "silent" | "pre-start-close" | "malformed" | "alternative-header" | "http" | "auth" | "vhost"

// Only the independent TCP peer uses codec scaffolding. Invalid protocol inputs are literal bytes.
const tcpPeer = Effect.fnUntraced(function*(behavior: Behavior) {
  const methods = yield* Queue.unbounded<Codec.Method | Error>()
  const accepted = yield* Queue.unbounded<Net.Socket>()
  const closed = yield* Queue.unbounded<void>()
  const sockets = new Set<Net.Socket>()
  let dials = 0
  const peers = yield* Queue.unbounded<Net.Socket>()
  yield* Stream.fromQueue(peers).pipe(
    Stream.runForEach(Effect.fnUntraced(function*(socket) {
      const decoder = yield* Codec.makeFrameDecoder()
      const chunks = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      let headerBytes = 0
      const reply = Effect.fnUntraced(function*(methodId: number, fields: Record<string, AMQPTypes.FieldValue> = {}) {
        socket.write(yield* Codec.encodeMethod(0, 10, methodId, fields))
      })
      const reject = (replyCode: number, replyText: string, methodId: number) =>
        reply(50, { replyCode, replyText, classId: 10, methodId })
      socket.on(
        "data",
        (chunk) => Queue.offerUnsafe(chunks, typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      )
      socket.on("close", () => Queue.endUnsafe(chunks))
      yield* Stream.fromQueue(chunks).pipe(
        Stream.runForEach(Effect.fnUntraced(function*(chunk) {
          let bytes = chunk
          if (headerBytes < 8) {
            const length = Math.min(bytes.length, 8 - headerBytes)
            const expected = [65, 77, 81, 80, 0, 0, 9, 1]
            for (let i = 0; i < length; i++) {
              if (bytes[i] !== expected[headerBytes + i]) {
                return yield* Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Unexpected protocol header" }))
              }
            }
            headerBytes += length
            bytes = bytes.subarray(length)
            if (headerBytes === 8) {
              switch (behavior) {
                case "silent":
                  return
                case "pre-start-close":
                  socket.end()
                  return
                case "malformed":
                  socket.write(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
                  return
                case "alternative-header":
                  socket.write(Buffer.from([65, 77, 81, 80, 0, 0, 8, 0]))
                  return
                case "http":
                  socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                  return
                default:
                  yield* reply(10, {
                    versionMajor: 0,
                    versionMinor: 9,
                    serverProperties: { product: "Independent loopback peer" },
                    mechanisms: "PLAIN",
                    locales: "en_US"
                  })
              }
            }
          }
          yield* decoder.feed(
            bytes,
            Effect.fnUntraced(function*(frame) {
              if (frame.type !== 1) {
                return yield* Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Unexpected client frame" }))
              }
              const method = yield* Codec.decodeMethod(frame.payload)
              yield* Queue.offer(methods, method)
              if (method.classId !== 10) {
                return yield* Effect.fail(new AMQPError.AMQPProtocolError({ reason: "Unexpected client method" }))
              }
              switch (method.methodId) {
                case 11:
                  if (behavior === "auth") yield* reject(403, "ACCESS_REFUSED - Login was refused using PLAIN", 11)
                  else yield* reply(30, { channelMax: 32, frameMax: 131072, heartbeat: 0 })
                  break
                case 40:
                  if (behavior === "vhost") yield* reject(530, "NOT_ALLOWED - vhost missing does not exist", 40)
                  else yield* reply(41)
                  break
                case 50:
                  yield* reply(51)
                  socket.end()
                  break
                case 51:
                  // Do not close from the peer: observe whether the client releases its actual socket.
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
        dials++
        sockets.add(socket)
        Queue.offerUnsafe(accepted, socket)
        socket.on("close", () => {
          sockets.delete(socket)
          Queue.offerUnsafe(closed, undefined)
        })
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
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
  )
  const address = server.address()
  if (address === null || typeof address === "string") return yield* Effect.die("Missing peer address")
  return {
    url: `amqp://127.0.0.1:${address.port}/missing`,
    methods,
    accepted,
    closed,
    dials: () => dials,
    sockets: () => sockets.size
  }
})

const nextMethod = Effect.fnUntraced(function*(methods: Queue.Queue<Codec.Method | Error>, methodId: number) {
  const method = yield* Queue.take(methods)
  if (method instanceof Error) return yield* Effect.die(method)
  expect(method.classId).toBe(10)
  expect(method.methodId).toBe(methodId)
  return method.fields
})

const options = {
  retryConnectionSchedule: Schedule.recurs(0),
  connectionTimeout: "1 second",
  shutdownTimeout: "1 second",
  waitConnectionTimeout: "1 second"
} satisfies AMQPConnection.AMQPConnectionOptions

describe("AMQP Node public connection scenarios over independent loopback TCP", () => {
  it.live("times out a silent TCP handshake using connectionTimeout and releases the socket", () =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer("silent")
      const connecting = yield* AMQPNodeConnection.make(peer.url, { ...options, connectionTimeout: "100 millis" }).pipe(
        Effect.exit,
        Effect.forkScoped
      )
      yield* Queue.take(peer.accepted)
      const exit = yield* Fiber.join(connecting)
      expectFailure(exit, {
        _tag: "AMQPConnectionError",
        reason: "AMQP handshake failed",
        cause: expect.objectContaining({ _tag: "TimeoutError" })
      })
      yield* Queue.take(peer.closed)
      expect(peer.sockets()).toBe(0)
      expect(peer.dials()).toBe(1)
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live.each([
    { behavior: "auth" as const, code: 403, methodId: 11, reason: "ACCESS_REFUSED - Login was refused using PLAIN" },
    { behavior: "vhost" as const, code: 530, methodId: 40, reason: "NOT_ALLOWED - vhost missing does not exist" }
  ])(
    "preserves $code $behavior diagnostics without retry and closes the TCP socket",
    ({ behavior, code, methodId, reason }) =>
      Effect.gen(function*() {
        const peer = yield* tcpPeer(behavior)
        const connecting = yield* AMQPNodeConnection.make(peer.url, {
          ...options,
          retryConnectionSchedule: Schedule.recurs(2)
        }).pipe(Effect.exit, Effect.forkScoped)
        yield* Queue.take(peer.accepted)
        expect((yield* nextMethod(peer.methods, 11)).mechanism).toBe("PLAIN")
        if (behavior === "vhost") {
          yield* nextMethod(peer.methods, 31)
          expect((yield* nextMethod(peer.methods, 40)).virtualHost).toBe("missing")
        }
        expectFailure(yield* Fiber.join(connecting), {
          _tag: "AMQPConnectionError",
          permanent: true,
          replyCode: code,
          classId: 10,
          methodId,
          reason
        })
        yield* Queue.take(peer.closed)
        expect(peer.sockets()).toBe(0)
        expect(peer.dials()).toBe(1)
      }).pipe(Effect.scoped, Effect.timeout("3 seconds"))
  )

  it.live.each([
    { behavior: "pre-start-close" as const },
    { behavior: "malformed" as const },
    { behavior: "alternative-header" as const },
    { behavior: "http" as const }
  ])("fails a $behavior first TCP response and cleans up", ({ behavior }) =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer(behavior)
      const exit = yield* AMQPNodeConnection.make(peer.url, options).pipe(Effect.exit)
      expectFailure(exit, {
        _tag: "AMQPConnectionError",
        ...(behavior === "pre-start-close" ? {} : { permanent: true })
      })
      if (behavior !== "pre-start-close" && Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        if (!(error instanceof AMQPError.AMQPConnectionError) || !Cause.isCause(error.cause)) {
          return yield* Effect.die("Missing retained protocol failure")
        }
        expect(Option.getOrUndefined(Cause.findErrorOption(error.cause))).toBeInstanceOf(AMQPError.AMQPProtocolError)
      }
      yield* Queue.take(peer.closed)
      expect(peer.sockets()).toBe(0)
      expect(peer.dials()).toBe(1)
      // No StartOk (or any method) may be sent in response to an invalid first input.
      expect(yield* Queue.size(peer.methods)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))

  it.live("fails createChannel after actual TCP disconnect when the reconnect policy is exhausted", () =>
    Effect.gen(function*() {
      const peer = yield* tcpPeer("ready")
      const connection = yield* AMQPNodeConnection.make(peer.url, options)
      const socket = yield* Queue.take(peer.accepted)
      expect((yield* connection.state).state).toBe("Ready")
      const failed = yield* connection.changes.pipe(
        Stream.filter((state) => state.state === "Failed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped
      )
      socket.destroy()
      yield* Queue.take(peer.closed)
      const states = yield* Fiber.join(failed)
      expect(states).toHaveLength(1)
      expectFailure(yield* connection.createChannel().pipe(Effect.exit), { _tag: "AMQPConnectionError" })
      expect(peer.dials()).toBe(1)
      expect(peer.sockets()).toBe(0)
      yield* connection.close
    }).pipe(Effect.scoped, Effect.timeout("3 seconds")))
})
