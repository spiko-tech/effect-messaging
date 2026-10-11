import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import type * as NodeNet from "node:net"
import { createServer } from "node:net"
import * as NATSConnection from "../src/NATSConnection.ts"

const info = (port: number) =>
  `INFO ${
    JSON.stringify({
      server_id: "native-test-server",
      server_name: "native-test-server",
      version: "2.15.0",
      go: "test",
      host: "127.0.0.1",
      port,
      proto: 1,
      max_payload: 1024,
      client_id: 1,
      headers: true
    })
  }\r\n`

const scriptedBroker = (script: (socket: NodeNet.Socket, port: number) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ readonly url: string; readonly close: () => Promise<void> }>((resolve, reject) => {
          const sockets = new Set<NodeNet.Socket>()
          const server = createServer((socket) => {
            sockets.add(socket)
            socket.on("error", () => undefined)
            socket.on("close", () => sockets.delete(socket))
            const address = server.address()
            if (address !== null && typeof address !== "string") script(socket, address.port)
          })
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (address === null || typeof address === "string") {
              reject(new Error("Scripted broker did not bind a TCP port"))
              return
            }
            resolve({
              url: `nats://127.0.0.1:${address.port}`,
              close: () =>
                new Promise<void>((done, fail) => {
                  for (const socket of sockets) socket.destroy()
                  server.close((error) => error ? fail(error) : done())
                })
            })
          })
        }),
      catch: (cause) => new Error("Cannot start scripted protocol peer", { cause })
    }),
    (broker) => Effect.promise(broker.close)
  )

describe("Adversarial server behavior", () => {
  it.live.each([
    { label: "invalid INFO JSON", greeting: "INFO {invalid}\r\n" },
    { label: "missing required INFO fields", greeting: "INFO {\"port\":4222}\r\n" },
    { label: "unknown protocol operation", greeting: "UNKNOWN bad\r\n" },
    { label: "invalid message framing", greeting: "MSG foo 1 invalid\r\n" }
  ])("rejects $label with a typed protocol error", ({ greeting }) =>
    Effect.gen(function*() {
      const broker = yield* scriptedBroker((socket) => socket.write(greeting))
      const error = yield* NATSConnection.NATSConnection.pipe(
        Effect.provide(NATSConnection.layerNode({ servers: broker.url, reconnect: false, timeout: 1000 })),
        Effect.flip
      )
      expect(error._tag).toBe("NATSConnectionError")
      expect(error.code).toBe("protocol_error")
    }).pipe(Effect.scoped))

  it.live("protocol corruption after CONNECT closes pending operations rather than reconnecting", () =>
    Effect.gen(function*() {
      const broker = yield* scriptedBroker((socket, port) => {
        socket.write(info(port))
        let received = ""
        socket.on("data", (data: Buffer) => {
          received += data.toString()
          if (received.includes("PING\r\n")) {
            received = ""
            socket.write("PONG\r\nUNKNOWN broken\r\n")
          }
        })
      })
      const failure = yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        return Option.getOrThrow(yield* connection.closed)
      }).pipe(
        Effect.provide(NATSConnection.layerNode({ servers: broker.url, reconnect: false, timeout: 1000 })),
        Effect.catch((error) => Effect.succeed(error))
      )
      expect(failure._tag).toBe("NATSConnectionError")
      expect(failure.code).toBe("protocol_error")
    }).pipe(Effect.scoped))
})
