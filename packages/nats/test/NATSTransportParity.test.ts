import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Stream } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as authFixture from "./fixtures/auth.ts"
import { makeServer, prepareTLS } from "./server.ts"

const roundTrip = Effect.gen(function*() {
  const connection = yield* NATSConnection.NATSConnection
  const subscription = yield* connection.subscribe("transport.parity", { max: 1 })
  yield* connection.publish("transport.parity", Uint8Array.of(0, 255, 13, 10))
  yield* connection.flush
  const received = yield* Stream.runCollect(subscription.stream)
  expect(received).toHaveLength(1)
  expect(received[0].data).toEqual(Uint8Array.of(0, 255, 13, 10))
})

describe("Isolated transport/authentication parity", () => {
  it.live("authenticates with a token and exchanges binary messages", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "authorization { token: \"test-token\" }" })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, token: "test-token" })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("authenticates with user/password and exchanges binary messages", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        config: "authorization { users: [{ user: \"alice\", password: \"secret\" }] }"
      })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        user: "alice",
        pass: "secret"
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("authenticates by signing the server nonce with a native NKey authenticator", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        config: "authorization { users: [{ nkey: \"UAH42UG6PV552P5SWLWTBP3H3S5BHAVCO2IEKEXUANJXR75J63RQ5WM6\" }] }"
      })
      const seed = new TextEncoder().encode("SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4")
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        authenticator: NATSAuth.nkeyAuthenticator(seed)
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("rejects invalid credentials without reconnecting indefinitely", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "authorization { token: \"test-token\" }" })
      const error = yield* roundTrip.pipe(
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          token: "wrong",
          reconnect: false,
          timeout: 1000
        })),
        Effect.flip
      )
      expect(error._tag).toBe("NATSConnectionError")
      expect(error.reason.toLowerCase()).toMatch(/authorization|authentication/)
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("upgrades an INFO-first TCP connection to verified TLS", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
      })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        tls: { caFile: join(server.directory, "server.crt") }
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("rejects an untrusted TLS server", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
      })
      const error = yield* roundTrip.pipe(
        Effect.provide(NATSConnection.layerNode({ servers: server.url, reconnect: false, timeout: 1000, tls: {} })),
        Effect.flip
      )
      expect(error._tag).toBe("NATSConnectionError")
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("rejects a certificate hostname mismatch during INFO-first TLS upgrade", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
      })
      const error = yield* roundTrip.pipe(
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          reconnect: false,
          timeout: 1000,
          tls: { caFile: join(server.directory, "server.crt"), servername: "wrong.example" }
        })),
        Effect.flip
      )
      expect(error._tag).toBe("NATSConnectionError")
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("supports handshake-first TLS with a trusted certificate", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\", handshake_first: true }"
      })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        tls: { caFile: join(server.directory, "server.crt"), handshakeFirst: true }
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("accepts a trusted client certificate for mutual TLS", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: [
          "tls {",
          "cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\",",
          "ca_file: \"/fixture/server.crt\", verify: true",
          "}"
        ].join("\n")
      })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        tls: {
          caFile: join(server.directory, "server.crt"),
          certFile: join(server.directory, "server.crt"),
          keyFile: join(server.directory, "server.key")
        }
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("supports PEM contents in Node TLS options", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
      })
      const ca = yield* Effect.promise(() => readFile(join(server.directory, "server.crt"), "utf8"))
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, tls: { ca } })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("exchanges binary payloads over native WebSocket transport", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: "websocket { port: 8080, no_tls: true }" })
      yield* roundTrip.pipe(Effect.provide(NATSConnection.layerWebSocket({ servers: server.websocketUrl })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("restores subscriptions after an explicit reconnect", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe("transport.reconnect", { max: 2 })
        yield* connection.publish("transport.reconnect", "before")
        yield* connection.flush
        yield* connection.reconnect
        yield* connection.publish("transport.reconnect", "after")
        yield* connection.flush
        const messages = yield* subscription.stream.pipe(
          Stream.mapEffect((message) => message.string),
          Stream.runCollect
        )
        expect(messages).toEqual(["before", "after"])
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, reconnectTimeWait: 10 })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("reconnects after broker restart and restores subscriptions", () =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const states = yield* Queue.unbounded<NATSConnection.ConnectionState>()
        yield* connection.changes.pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkChild
        )
        expect((yield* Queue.take(states)).state).toBe("Connected")
        const subscription = yield* connection.subscribe("transport.restart", { max: 3 })
        const received = yield* subscription.stream.pipe(
          Stream.mapEffect((message) => message.string),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* connection.publish("transport.restart", "before")
        yield* connection.flush
        yield* server.stop
        let state = yield* Queue.take(states)
        while (state.state !== "Reconnecting") state = yield* Queue.take(states)
        yield* server.start
        state = yield* Queue.take(states)
        while (state.state !== "Connected") state = yield* Queue.take(states)
        yield* connection.publish("transport.restart", "after-one")
        yield* connection.publish("transport.restart", "after-two")
        yield* connection.flush
        expect(yield* Fiber.join(received)).toEqual(["before", "after-one", "after-two"])
      }).pipe(Effect.provide(NATSConnection.layerNode({
        servers: server.url,
        reconnectTimeWait: 10,
        reconnectJitter: 0,
        maxReconnectAttempts: 1000
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("fails over to another configured server and restores subscriptions", () =>
    Effect.gen(function*() {
      const first = yield* makeServer()
      const second = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const subscription = yield* connection.subscribe("transport.failover", { max: 2 })
        yield* connection.publish("transport.failover", "before")
        yield* connection.flush
        const initialServer = yield* connection.getServer
        yield* connection.setServers([second.url])
        yield* connection.reconnect
        expect(yield* connection.getServer).not.toBe(initialServer)
        yield* connection.publish("transport.failover", "after")
        yield* connection.flush
        const messages = yield* subscription.stream.pipe(
          Stream.mapEffect((message) => message.string),
          Stream.runCollect
        )
        expect(messages).toEqual(["before", "after"])
      }).pipe(Effect.provide(NATSConnection.layerNode({
        servers: [first.url, second.url],
        noRandomize: true,
        reconnectTimeWait: 10
      })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live(
    "a permission-denied request fails with its subject and permits subsequent allowed traffic",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config:
            "authorization { users: [{ user: \"limited\", password: \"secret\", permissions: { publish: { allow: [\"allowed.>\"] }, subscribe: { allow: [\">\"] } } }] }"
        })
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const error = yield* connection.request("forbidden.request", "hello", { timeout: 1000 }).pipe(Effect.flip)
          expect(error.reason.toLowerCase()).toMatch(/permission/)
          expect(error.subject).toBe("forbidden.request")
          const subscription = yield* connection.subscribe("allowed.subject", { max: 1 })
          yield* connection.publish("allowed.subject", "still connected")
          expect(yield* subscription.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect))
            .toEqual(["still connected"])
        }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "limited", pass: "secret" })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )

  it.live(
    "a permission-denied subscription fails its stream without closing the connection",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config:
            "authorization { users: [{ user: \"limited\", password: \"secret\", permissions: { publish: { allow: [\">\"] }, subscribe: { allow: [\"allowed.>\"] } } }] }"
        })
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const subscription = yield* connection.subscribe("forbidden.subscription")
          const error = yield* Stream.runCollect(subscription.stream).pipe(Effect.flip)
          expect(error._tag).toBe("NATSSubscriptionError")
          expect(error.reason.toLowerCase()).toMatch(/permission/)
          expect(yield* connection.isClosed).toBe(false)
          yield* connection.flush
        }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "limited", pass: "secret" })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )

  it.live.each(["JWT", "credentials"] as const)(
    "authenticates with native %s and trusted account claims",
    (mode) =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          jetstream: false,
          config: [
            `operator: "${authFixture.operatorJWT}"`,
            "resolver: \"MEMORY\"",
            `resolver_preload: { ${authFixture.account}: "${authFixture.accountJWT}" }`
          ].join("\n")
        })
        const credentials = new TextEncoder().encode([
          "-----BEGIN NATS USER JWT-----",
          authFixture.userJWT,
          "------END NATS USER JWT------",
          "-----BEGIN USER NKEY SEED-----",
          authFixture.userSeed,
          "------END USER NKEY SEED------"
        ].join("\n"))
        const authenticator = mode === "JWT"
          ? NATSAuth.jwtAuthenticator(authFixture.userJWT, new TextEncoder().encode(authFixture.userSeed))
          : NATSAuth.credsAuthenticator(credentials)
        yield* roundTrip.pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, authenticator })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )

  it.live(
    "a TLS reconnect reacquires the verified transport and restores subscription limits",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          prepare: prepareTLS,
          config: "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\" }"
        })
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          const subscription = yield* connection.subscribe("native.tls.reconnect", { max: 2 })
          yield* connection.publish("native.tls.reconnect", "before")
          yield* connection.flush
          yield* connection.reconnect
          yield* connection.publish("native.tls.reconnect", "after")
          yield* connection.publish("native.tls.reconnect", "over limit")
          const received = yield* subscription.stream.pipe(
            Stream.mapEffect((message) => message.string),
            Stream.runCollect
          )
          expect(received).toEqual(["before", "after"])
          expect(yield* subscription.getReceived).toBe(2)
        }).pipe(Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          tls: { caFile: join(server.directory, "server.crt") },
          reconnectTimeWait: 10
        })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )

  it.live("mutual TLS rejects a client without its certificate", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        prepare: prepareTLS,
        config:
          "tls { cert_file: \"/fixture/server.crt\", key_file: \"/fixture/server.key\", ca_file: \"/fixture/server.crt\", verify: true }"
      })
      const error = yield* roundTrip.pipe(
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          reconnect: false,
          timeout: 1000,
          tls: { caFile: join(server.directory, "server.crt") }
        })),
        Effect.flip
      )
      expect(error._tag).toBe("NATSConnectionError")
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
