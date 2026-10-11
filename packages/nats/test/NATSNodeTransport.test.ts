import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { execFile } from "node:child_process"
import { lookup } from "node:dns/promises"
import * as Net from "node:net"
import { join } from "node:path"
import { promisify } from "node:util"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeSocket } from "../src/NATSNodeConnection.ts"
import { makeServer } from "./server.ts"

const execute = promisify(execFile)

describe("native Node socket ownership", () => {
  it.live(
    "default DNS resolution falls back between families while resolve false uses the first address",
    () =>
      Effect.gen(function*() {
        const addresses = yield* Effect.tryPromise(() => lookup("localhost", { all: true }))
        expect(new Set(addresses.map((address) => address.family))).toEqual(new Set([4, 6]))
        const host = addresses[0].family === 6 ? "127.0.0.1" : "::1"
        const peers = new Set<Net.Socket>()
        const server = yield* Effect.acquireRelease(
          Effect.callback<Net.Server, Error>((resume) => {
            const server = Net.createServer((socket) => {
              peers.add(socket)
              socket.once("close", () => peers.delete(socket))
            })
            server.once("error", (error) => resume(Effect.fail(error)))
            server.listen({ port: 0, host, ipv6Only: true }, () => resume(Effect.succeed(server)))
          }),
          (server) =>
            Effect.sync(() => {
              for (const peer of peers) peer.destroy()
              server.close()
            })
        )
        const address = Option.fromNullishOr(server.address())
        if (Option.isNone(address) || typeof address.value === "string") throw new Error("TCP fixture address missing")
        const endpoint = new URL(`nats://localhost:${address.value.port}`)
        yield* Effect.scoped(Effect.gen(function*() {
          const socket = yield* makeSocket(endpoint, {})
          yield* socket.reader
        })).pipe(Effect.timeout("2 seconds"))
        const firstOnly = yield* Effect.scoped(Effect.gen(function*() {
          const socket = yield* makeSocket(endpoint, { resolve: false })
          yield* socket.reader
        })).pipe(Effect.result)
        expect(firstOnly._tag).toBe("Failure")
      }).pipe(Effect.scoped),
    { timeout: 10_000 }
  )
  it.live(
    "verifies gossiped IP endpoints against their preserved DNS identity and respects explicit overrides",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }",
          prepare: async (directory) => {
            await execute("openssl", [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-days",
              "1",
              "-keyout",
              join(directory, "server.key"),
              "-out",
              join(directory, "server.crt"),
              "-subj",
              "/CN=localhost",
              "-addext",
              "subjectAltName=DNS:localhost"
            ])
          }
        })
        const caFile = join(server.directory, "server.crt")
        yield* Effect.scoped(Effect.gen(function*() {
          const connection = yield* NATSConnection.make(
            (endpoint) => makeSocket(new URL(endpoint), { tls: { caFile } }, "localhost"),
            { servers: server.url, tls: {}, reconnect: false, timeout: 2000 }
          )
          yield* connection.flush
        }))
        const failure = yield* Effect.scoped(NATSConnection.make(
          (endpoint) => makeSocket(new URL(endpoint), { tls: { caFile, servername: "wrong.example" } }, "localhost"),
          { servers: server.url, tls: {}, reconnect: false, timeout: 2000 }
        )).pipe(Effect.result)
        expect(failure._tag).toBe("Failure")
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )

  it.live("interrupts a stalled INFO-first TLS handshake and closes the peer socket", () =>
    Effect.gen(function*() {
      const hello = yield* Deferred.make<void>()
      const peerClosed = yield* Deferred.make<void>()
      const peers = new Set<Net.Socket>()
      const server = yield* Effect.acquireRelease(
        Effect.callback<Net.Server, Error>((resume) => {
          const server = Net.createServer((socket) => {
            peers.add(socket)
            socket.once("data", () => Deferred.doneUnsafe(hello, Effect.void))
            socket.once("close", () => {
              peers.delete(socket)
              Deferred.doneUnsafe(peerClosed, Effect.void)
            })
          })
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
          return Effect.sync(() => {
            if (!server.listening) server.close()
          })
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            for (const peer of peers) peer.destroy()
            server.close(() => resume(Effect.void))
          }),
        { interruptible: true }
      )
      const address = Option.fromNullishOr(server.address())
      if (Option.isNone(address) || typeof address.value === "string") throw new Error("TCP fixture address missing")
      const socket = yield* makeSocket(new URL(`nats://127.0.0.1:${address.value.port}`), {
        tls: { rejectUnauthorized: false }
      })
      const reader = yield* socket.reader
      const upgrading = yield* reader.upgrade().pipe(Effect.forkScoped)
      yield* Deferred.await(hello).pipe(Effect.timeout("2 seconds"))
      yield* Fiber.interrupt(upgrading).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.await(peerClosed).pipe(Effect.timeout("2 seconds"))
      expect(peers.size).toBe(0)
    }).pipe(Effect.scoped), { timeout: 5000 })
})
