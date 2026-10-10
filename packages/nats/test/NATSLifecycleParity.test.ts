import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { execFile } from "node:child_process"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { join } from "node:path"
import { promisify } from "node:util"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSHeaders from "../src/NATSHeaders.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeServer, prepareTLS } from "./server.ts"

const execute = promisify(execFile)
const awaitEvent = (events: Queue.Queue<NATSOptions.Status>, type: NATSOptions.Status["type"]) =>
  Effect.gen(function*() {
    while (true) {
      const event = yield* Queue.take(events)
      if (event.type === type) return event
    }
  })
const observe = (connection: NATSConnection.NATSConnection) =>
  Effect.gen(function*() {
    const events = yield* Queue.unbounded<NATSOptions.Status>()
    const status = yield* connection.status
    const running = yield* status.pipe(Stream.runForEach((event) => Queue.offer(events, event)), Effect.forkChild)
    return { events, running }
  })
const peer = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new Promise<{ url: string; update: (fields: object) => void; close: () => Promise<void> }>((resolve) => {
        let connection: Socket | undefined
        let port = 0
        const info = (fields: object) =>
          "INFO " + JSON.stringify({
            server_id: "lifecycle-test",
            server_name: "lifecycle-test",
            version: "2.15.0",
            go: "go1.26",
            host: "127.0.0.1",
            port,
            proto: 1,
            client_id: 1,
            max_payload: 1024 * 1024,
            headers: true,
            ...fields
          }) + "\r\n"
        const server = createServer((socket) => {
          connection = socket
          socket.write(info({}))
          let received = ""
          socket.on("data", (data) => {
            received += data.toString()
            while (received.includes("PING\r\n")) {
              received = received.slice(received.indexOf("PING\r\n") + 6)
              socket.write("PONG\r\n")
            }
          })
        })
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (address === null || typeof address === "string") throw new Error("Missing peer address")
          port = address.port
          resolve({
            url: `nats://127.0.0.1:${port}`,
            update: (fields) => connection?.write(info(fields)),
            close: () =>
              new Promise((done, fail) => {
                connection?.destroy()
                server.close((error) => error ? fail(error) : done())
              })
          })
        })
      }),
    catch: (cause) => new Error("Cannot start protocol peer", { cause })
  }),
  (server) => Effect.promise(server.close)
)

describe("Exact upstream lifecycle and event laws", { concurrent: false }, () => {
  it.live("clobber - buffers don't clobber", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const iterations = 250 * 1024
        const data = new Uint8Array(iterations * 1024)
        for (let index = 0; index < data.length; index++) data[index] = 97 + index % 26
        const subject = yield* connection.createInbox
        const sub = yield* connection.subscribe(subject, { max: iterations })
        const received: Array<Uint8Array> = []
        const reading = yield* sub.stream.pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              received.push(message.data)
            })
          ),
          Effect.forkChild
        )
        for (let index = 0; index < iterations; index++) {
          yield* connection.publish(subject, data.subarray(index * 1024, (index + 1) * 1024))
        }
        yield* Fiber.join(reading)
        expect(received).toHaveLength(iterations)
        let mismatch = -1
        for (let message = 0; message < received.length && mismatch === -1; message++) {
          if (received[message].length !== 1024) mismatch = message * 1024
          for (let byte = 0; byte < 1024 && mismatch === -1; byte++) {
            if (received[message][byte] !== data[message * 1024 + byte]) mismatch = message * 1024 + byte
          }
        }
        expect(mismatch).toBe(-1)
      }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: server.url })))
    }).pipe(Effect.scoped), { timeout: 120_000 })

  it.live.each(["close handler is called on close", "close process inbound ignores"])(
    "disconnect - %s",
    (_law) =>
      Effect.gen(function*() {
        const server = yield* makeServer()
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const closed = yield* connection.closed.pipe(Effect.forkChild)
          yield* server.stop
          yield* Fiber.join(closed)
          expect(yield* connection.isClosed).toBe(true)
        }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, reconnect: false })))
      }).pipe(Effect.scoped)
  )

  it.live.each([false, true])("doublesubs - tls=%s", (tls) =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        ...(tls ? { prepare: prepareTLS } : {}),
        config: "trace:true\n" + (tls ? "tls {cert_file:\"/fixture/server.crt\",key_file:\"/fixture/server.key\"}" : "")
      })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const { events } = yield* observe(connection)
        yield* connection.flush
        yield* server.stop
        yield* awaitEvent(events, "disconnect")
        const subjects = ["foo", "bar", "baz"]
        const subscriptions = yield* Effect.forEach(subjects, (subject) => connection.subscribe(subject))
        const headers = NATSHeaders.headers()
        headers.set("foo", "bar")
        yield* connection.publish("foo")
        yield* connection.publish("bar", "hello")
        yield* connection.publish("baz", undefined, { headers })
        yield* server.start
        yield* awaitEvent(events, "reconnect")
        yield* connection.flush
        for (const sub of subscriptions) expect(yield* sub.getReceived).toBe(0)
        const logs = yield* Effect.promise(() => execute("docker", ["logs", server.name]))
        const registered = [...(logs.stdout + logs.stderr).matchAll(/\[SUB (\S+) \d+\]/g)].map((match) => match[1])
        expect(registered.sort()).toEqual(subjects.sort())
      }).pipe(
        Effect.scoped,
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 25,
          reconnectJitter: 0,
          reconnectJitterTLS: 0,
          ...(tls ? { tls: { caFile: join(server.directory, "server.crt") } } : {})
        }))
      )
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("events - close on close", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.close
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.provide(NATSConnection.layerNode())))

  it.live("events - disconnect and close", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const { events, running } = yield* observe(connection)
        yield* server.stop
        expect((yield* awaitEvent(events, "disconnect")).type).toBe("disconnect")
        expect(yield* connection.closed).toEqual(Option.none())
        yield* Fiber.join(running)
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, reconnect: false })))
    }).pipe(Effect.scoped))

  it.live("events - disreconnect", () =>
    Effect.gen(function*() {
      const first = yield* makeServer()
      const second = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const { events } = yield* observe(connection)
        yield* first.stop
        yield* awaitEvent(events, "disconnect")
        yield* awaitEvent(events, "reconnect")
        expect(yield* connection.getServer).toBe(second.url)
      }).pipe(Effect.provide(NATSConnection.layerNode({
        servers: [first.url, second.url],
        noRandomize: true,
        maxReconnectAttempts: 1,
        reconnectTimeWait: 0,
        reconnectJitter: 0
      })))
    }).pipe(Effect.scoped))

  it.live.each([false, true])("events - server update ignored=%s", (ignoreClusterUpdates) =>
    Effect.gen(function*() {
      const server = yield* peer
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const { events } = yield* observe(connection)
        expect(yield* connection.getServers).toHaveLength(1)
        server.update({ connect_urls: [new URL(server.url).host, "127.0.0.1:49999"] })
        yield* connection.flush
        if (ignoreClusterUpdates) expect(yield* connection.getServers).toHaveLength(1)
        else {
          const event = yield* awaitEvent(events, "update")
          expect(event).toMatchObject({ added: ["nats://127.0.0.1:49999"] })
          expect(yield* connection.getServers).toHaveLength(2)
        }
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, ignoreClusterUpdates })))
    }).pipe(Effect.scoped))

  it.live("events - ldm", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "lame_duck_duration:\"30s\"\nlame_duck_grace_period:\"1s\"" })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const { events } = yield* observe(connection)
        yield* Effect.promise(() => execute("docker", ["kill", "--signal", "USR2", server.name]))
        expect((yield* awaitEvent(events, "ldm")).type).toBe("ldm")
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url })))
    }).pipe(Effect.scoped))

  it.live("events - clean up", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const { events, running } = yield* observe(connection)
      yield* connection.reconnect
      yield* awaitEvent(events, "reconnect")
      yield* connection.close
      yield* Fiber.join(running)
      expect(yield* connection.closed).toEqual(Option.none())
    }).pipe(Effect.provide(NATSConnection.layerNode())))

  it.live("cmdlauncher - test", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "debug:true\ntrace:true" })
      yield* NATSConnection.NATSConnection.pipe(
        Effect.flatMap((connection) => connection.flush),
        Effect.provide(NATSConnection.layerNode({ servers: server.url }))
      )
      yield* server.stop
      const logs = yield* Effect.promise(() => execute("docker", ["logs", server.name]))
      expect(logs.stdout + logs.stderr).toContain("Server is ready")
    }).pipe(Effect.scoped))
})
