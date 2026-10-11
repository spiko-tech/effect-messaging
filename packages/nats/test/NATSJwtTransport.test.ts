import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeJWTFixture } from "./fixtures/jwt.ts"
import { makeServer } from "./server.ts"

const encoder = new TextEncoder()

const exchange = (connection: NATSConnection.NATSConnection) =>
  Effect.gen(function*() {
    const sub = yield* connection.subscribe("jwt.rotation", { max: 1 })
    yield* connection.publish("jwt.rotation", "authenticated")
    yield* connection.flush
    const messages = yield* Stream.runCollect(sub.stream)
    expect(messages).toHaveLength(1)
    expect(yield* messages[0].string).toBe("authenticated")
  })

describe("native JWT operator authentication", () => {
  it.live.each(["expired", "revoked"] as const)("rejects %s user credentials", (mode) =>
    Effect.gen(function*() {
      const auth = yield* makeJWTFixture(mode === "revoked")
      const server = yield* makeServer({ config: auth.config, jetstream: false })
      const result = yield* Effect.scoped(NATSConnection.make(
        (endpoint) =>
          Effect.gen(function*() {
            const node = yield* Effect.promise(() => import("../src/NATSNodeConnection.ts"))
            return yield* node.makeSocket(new URL(endpoint))
          }),
        {
          servers: server.url,
          reconnect: false,
          timeout: 2000,
          authenticator: NATSAuth.jwtAuthenticator(
            mode === "expired" ? auth.expiredJWT : auth.firstJWT,
            auth.first.seed
          )
        }
      )).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("authorization")
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live.each(["JWT", "credentials"] as const)(
    "rotates %s and signing seed on a physical reconnect",
    (mode) =>
      Effect.gen(function*() {
        const auth = yield* makeJWTFixture()
        const server = yield* makeServer({ config: auth.config, jetstream: false })
        let token = auth.firstJWT
        let seed = auth.first.seed
        let challenges = 0
        const authenticator = mode === "JWT" ?
          NATSAuth.jwtAuthenticator(() => {
            challenges++
            return token
          }, () => seed) :
          NATSAuth.credsAuthenticator(() => {
            challenges++
            return encoder.encode([
              "-----BEGIN NATS USER JWT-----",
              token,
              "------END NATS USER JWT------",
              "-----BEGIN USER NKEY SEED-----",
              new TextDecoder().decode(seed),
              "------END USER NKEY SEED------"
            ].join("\n"))
          })
        yield* Effect.gen(function*() {
          const connection = yield* NATSConnection.NATSConnection
          yield* exchange(connection)
          expect(challenges).toBe(1)
          token = auth.secondJWT
          seed = auth.second.seed
          yield* connection.reconnect.pipe(Effect.timeout("5 seconds"))
          yield* exchange(connection)
          expect(challenges).toBe(2)
        }).pipe(Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          authenticator,
          reconnectTimeWait: 1,
          reconnectJitter: 0,
          timeout: 2000
        })))
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
})
