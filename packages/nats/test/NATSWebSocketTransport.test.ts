import { NodeWS } from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeSocket, normalizeServer } from "../src/NATSWebSocketConnection.ts"
import { makeServer, prepareTLS } from "./server.ts"

class TestWebSocket implements Socket.WebSocketLike {
  readyState = 1
  readonly closed = Deferred.makeUnsafe<void>()
  readonly sent: Array<string | Uint8Array<ArrayBuffer>> = []
  private readonly handlers = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>()
  addEventListener(type: string, handler: (event: Socket.WebSocketEvent) => void): void {
    const handlers = this.handlers.get(type) ?? new Set()
    handlers.add(handler)
    this.handlers.set(type, handlers)
  }
  removeEventListener(type: string, handler: (event: Socket.WebSocketEvent) => void): void {
    this.handlers.get(type)?.delete(handler)
  }
  close(code = 1000): void {
    this.readyState = 3
    this.emit("close", { code })
    Deferred.doneUnsafe(this.closed, Effect.void)
  }
  send(data: string | Uint8Array<ArrayBuffer>): void {
    this.sent.push(data)
  }
  emit(type: string, event: Socket.WebSocketEvent): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }
}

describe("native WebSocket factory ownership", () => {
  it.effect.each([
    ["foo", "wss://foo:443/"],
    ["foo:100", "wss://foo:100/"],
    ["foo/", "wss://foo:443/"],
    ["foo/hello", "wss://foo:443/hello"],
    ["foo:100/hello", "wss://foo:100/hello"],
    ["foo/hello?one=two", "wss://foo:443/hello?one=two"],
    ["foo:100/hello?one=two", "wss://foo:100/hello?one=two"],
    ["nats://foo", "ws://foo:80/"],
    ["tls://foo", "wss://foo:443/"],
    ["ws://foo", "ws://foo:80/"],
    ["ws://foo:100", "ws://foo:100/"],
    ["[2001:db8:1f70::999:de8:7648:6e8]", "wss://[2001:db8:1f70:0:999:de8:7648:6e8]:443/"],
    ["[2001:db8:1f70::999:de8:7648:6e8]:100", "wss://[2001:db8:1f70:0:999:de8:7648:6e8]:100/"],
    ["http://localhost", "ws://localhost:80/"],
    ["https://localhost", "wss://localhost:443/"]
  ])("normalizes official WebSocket endpoint %s", ([input, expected]) =>
    Effect.sync(() => {
      expect(normalizeServer(input)).toBe(expected)
    }))
  it.effect("normalizes bare endpoints with an explicit encrypted hint", () =>
    Effect.sync(() => {
      expect(normalizeServer("localhost", true)).toBe("wss://localhost:443/")
      expect(normalizeServer("localhost", false)).toBe("ws://localhost:80/")
    }))
  it.effect("rejects TLS configuration for a standard W3C WebSocket", () =>
    Effect.gen(function*() {
      const result = yield* makeSocket(new URL("wss://localhost:8443"), { tls: {} }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }))
  it.live("establishes a trusted secure WebSocket connection", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config:
          "websocket { port: 8080, tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" } }"
      })
      const ca = yield* Effect.promise(() => readFile(join(server.directory, "server.crt")))
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const sub = yield* connection.subscribe("native.wss", { max: 1 })
        yield* connection.publish("native.wss", "secure")
        expect(yield* sub.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)).toEqual([
          "secure"
        ])
      }).pipe(Effect.provide(NATSConnection.layerWebSocket({
        servers: server.websocketUrl.replace("ws:", "wss:"),
        webSocketConstructor: (url) => new NodeWS.WebSocket(url, { ca })
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live(
    "initial server selection and pool replacement dial the selected WebSocket endpoint",
    () =>
      Effect.gen(function*() {
        const first = yield* makeServer({ config: "websocket { port: 8080, no_tls: true }" })
        const second = yield* makeServer({ config: "websocket { port: 8080, no_tls: true }" })
        let calls = 0
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          expect(calls).toBe(1)
          expect(yield* connection.isClosed).toBe(false)
          const pool = yield* connection.getServers
          expect(pool).toHaveLength(1)
          expect(pool[0].listen).toBe(first.websocketUrl + "/")
          yield* connection.setServers([second.websocketUrl])
          yield* connection.reconnect
          expect(yield* connection.getServer).toBe(second.websocketUrl + "/")
          expect(calls).toBe(2)
          yield* connection.close
          expect(yield* connection.isClosed).toBe(true)
        }).pipe(Effect.provide(NATSConnection.layerWebSocket({
          servers: first.websocketUrl,
          reconnectTimeWait: 1,
          reconnectJitter: 0,
          reconnectToServer: (pool, info) => {
            calls++
            expect(pool).toHaveLength(1)
            if (calls === 1) expect(info).toEqual(Option.none())
            return Option.some(pool[0])
          }
        })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.effect("owns an Effect-created WebSocket and exchanges binary frames", () =>
    Effect.gen(function*() {
      const ws = new TestWebSocket()
      yield* Effect.scoped(Effect.gen(function*() {
        const socket = yield* makeSocket(new URL("ws://localhost:9222"), {
          wsFactory: () => Effect.succeed({ socket: ws, encrypted: false })
        })
        const reader = yield* socket.reader
        const writer = yield* socket.writer
        yield* writer.write(Uint8Array.of(0, 255))
        ws.emit("message", { data: Uint8Array.of(13, 10) })
        expect(yield* reader.pull).toEqual([Uint8Array.of(13, 10)])
        expect(ws.sent).toEqual([Uint8Array.of(0, 255)])
      }))
      expect(ws.readyState).toBe(3)
    }))
  it.effect("injects a constructor and forwards subprotocols", () =>
    Effect.gen(function*() {
      const ws = new TestWebSocket()
      let observed: Socket.WebSocketConstructorOptions | undefined
      yield* Effect.scoped(Effect.gen(function*() {
        const socket = yield* makeSocket(new URL("ws://localhost:9222"), {
          protocols: ["nats"],
          webSocketConstructor: (url, options) => {
            expect(url).toBe("ws://localhost:9222/")
            observed = options
            return ws
          }
        })
        yield* socket.reader
      }))
      expect(observed).toEqual(["nats"])
      expect(ws.readyState).toBe(3)
    }))
  it.live("interrupts pending Promise factories and closes late-created sockets", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const ws = new TestWebSocket()
      let resolve: ((result: NATSOptions.WebSocketFactoryResult) => void) | undefined
      const promise = new Promise<NATSOptions.WebSocketFactoryResult>((complete) => {
        resolve = complete
      })
      const socket = yield* makeSocket(new URL("ws://localhost:9222"), {
        wsFactory: () => {
          Deferred.doneUnsafe(started, Effect.void)
          return promise
        }
      })
      const acquiring = yield* socket.reader.pipe(Effect.scoped, Effect.forkScoped)
      yield* Deferred.await(started).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error("Factory start notification timed out"))
      }))
      yield* Fiber.interrupt(acquiring).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error("Factory interruption timed out"))
      }))
      if (resolve === undefined) throw new Error("Factory resolver missing")
      resolve({ socket: ws, encrypted: false })
      yield* Deferred.await(ws.closed).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error("Late factory websocket cleanup timed out"))
      }))
      expect(ws.readyState).toBe(3)
    }).pipe(Effect.scoped), { timeout: 5000 })
  it.effect("maps thrown and rejected factories to typed socket errors", () =>
    Effect.gen(function*() {
      for (
        const wsFactory of [
          () => {
            throw new Error("factory threw")
          },
          () => Promise.reject(new Error("factory rejected")),
          () =>
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({
                  kind: "Unknown",
                  cause: new Error("factory failed")
                })
              })
            )
        ]
      ) {
        const socket = yield* makeSocket(new URL("ws://localhost:9222"), { wsFactory })
        const result = yield* socket.reader.pipe(Effect.scoped, Effect.result)
        expect(result._tag).toBe("Failure")
      }
    }))
  it.effect("rejects a plaintext factory when TLS is required and closes it", () =>
    Effect.gen(function*() {
      const ws = new TestWebSocket()
      const socket = yield* makeSocket(new URL("ws://localhost:9222"), {
        tls: {},
        wsFactory: () => ({ socket: ws, encrypted: false })
      })
      expect((yield* socket.reader.pipe(Effect.scoped, Effect.result))._tag).toBe("Failure")
      expect(ws.readyState).toBe(3)
    }))
  it.effect("enforces the custom WebSocket receive buffer budget", () =>
    Effect.gen(function*() {
      const ws = new TestWebSocket()
      const socket = yield* makeSocket(new URL("ws://localhost:9222"), {
        highWaterMark: 4,
        wsFactory: () => ({ socket: ws, encrypted: false })
      })
      const reader = yield* socket.reader
      ws.emit("message", { data: Uint8Array.of(1, 2, 3, 4, 5) })
      expect(yield* reader.pull).toEqual([Uint8Array.of(1, 2, 3, 4, 5)])
      expect((yield* reader.pull.pipe(Effect.result))._tag).toBe("Failure")
    }))
})
