import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeJWTFixture } from "./fixtures/jwt.ts"
import { makeServer } from "./server.ts"

const seed = new TextEncoder().encode("SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4")
const publicKey = "UAH42UG6PV552P5SWLWTBP3H3S5BHAVCO2IEKEXUANJXR75J63RQ5WM6"
const verifyReconnect = (authenticator: NATSAuth.Authenticator, config: string) =>
  Effect.gen(function*() {
    const server = yield* makeServer({ config, jetstream: false })
    let calls = 0
    yield* Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      yield* connection.flush
      expect(calls).toBe(1)
      yield* connection.reconnect.pipe(Effect.timeout("5 seconds"))
      yield* connection.flush
      expect(calls).toBe(2)
      expect(yield* connection.isClosed).toBe(false)
    }).pipe(Effect.provide(NATSConnection.layerNode({
      servers: server.url,
      reconnectTimeWait: 1,
      reconnectJitter: 0,
      authenticator: (nonce) => {
        calls++
        return NATSAuth.resolveAuthenticator(authenticator, nonce)
      }
    })))
  }).pipe(Effect.scoped)

describe("native NATS authentication", () => {
  it.live.each(["both callbacks", "password callback", "username callback"] as const)(
    "re-evaluates username/password %s on reconnect",
    (mode) =>
      verifyReconnect(
        NATSAuth.usernamePasswordAuthenticator(
          mode === "password callback" ? "a" : () => "a",
          mode === "username callback" ? "a" : () => "a"
        ),
        "authorization { users: [{ user: \"a\", password: \"a\" }] }"
      ),
    { timeout: 30_000 }
  )
  it.live(
    "re-evaluates token callback on reconnect",
    () => verifyReconnect(NATSAuth.tokenAuthenticator(() => "tok"), "authorization { token: \"tok\" }"),
    { timeout: 30_000 }
  )
  it.live(
    "re-evaluates NKey seed callback on reconnect",
    () =>
      verifyReconnect(NATSAuth.nkeyAuthenticator(() => seed), `authorization { users: [{ nkey: "${publicKey}" }] }`),
    { timeout: 30_000 }
  )
  it.live("re-evaluates bearer JWT callback on reconnect without a signing seed", () =>
    Effect.gen(function*() {
      const fixture = yield* makeJWTFixture()
      yield* verifyReconnect(NATSAuth.jwtAuthenticator(() => fixture.bearerJWT), fixture.config)
    }), { timeout: 30_000 })
  it.effect("rejects malformed plain-text credentials through the typed failure channel", () =>
    Effect.gen(function*() {
      const result = yield* NATSAuth.credsAuthenticator(new TextEncoder().encode("hello"))().pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("NATSAuthError")
        expect(result.failure.message).toBe("Unable to decode credentials")
      }
    }))
  it.effect("resolves token and username password dynamically", () =>
    Effect.gen(function*() {
      let token = "first"
      const authenticate = NATSAuth.tokenAuthenticator(() => token)
      expect(yield* authenticate()).toEqual({ auth_token: "first" })
      token = "second"
      expect(yield* authenticate()).toEqual({ auth_token: "second" })
      expect(yield* NATSAuth.usernamePasswordAuthenticator(() => "user", () => "secret")()).toEqual({
        user: "user",
        pass: "secret"
      })
      expect(yield* NATSAuth.noAuthFn()()).toEqual({})
    }))
  it.effect("signs a nonce using validated Ed25519 NKey seed", () =>
    Effect.gen(function*() {
      const auth = yield* NATSAuth.nkeyAuthenticator(seed)("challenge")
      expect(auth.nkey).toBe(publicKey)
      expect(auth.sig).toHaveLength(88)
      const verify = yield* Effect.promise(async () => {
        // The public JWK is derived independently by decoding the NKey public key.
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        let value = 0
        let bits = 0
        const bytes: Array<number> = []
        for (const char of publicKey) {
          value = (value << 5) | alphabet.indexOf(char)
          bits += 5
          if (bits >= 8) {
            bits -= 8
            bytes.push((value >>> bits) & 255)
          }
        }
        const key = await crypto.subtle.importKey("raw", Uint8Array.from(bytes.slice(1, 33)), "Ed25519", false, [
          "verify"
        ])
        return await crypto.subtle.verify(
          "Ed25519",
          key,
          Uint8Array.from(atob(auth.sig ?? ""), (char) => char.charCodeAt(0)),
          new TextEncoder().encode("challenge")
        )
      })
      expect(verify).toBe(true)
      expect(new TextDecoder().decode(seed)).toBe("SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4")
    }))
  it.effect("rejects invalid alphabet checksum length and credentials", () =>
    Effect.gen(function*() {
      for (const input of ["BAD!", "SU", new TextDecoder().decode(seed).slice(0, -1) + "A"]) {
        const result = yield* NATSAuth.nkeyAuthenticator(new TextEncoder().encode(input))("challenge").pipe(
          Effect.result
        )
        expect(result._tag).toBe("Failure")
      }
      expect((yield* NATSAuth.credsAuthenticator(new Uint8Array())().pipe(Effect.result))._tag).toBe("Failure")
    }))
  it.effect("supports composite authenticator rotation and failure propagation", () =>
    Effect.gen(function*() {
      let jwt = "first.jwt"
      let token = "first.token"
      const authenticate = NATSAuth.buildAuthenticator({
        authenticator: [
          NATSAuth.jwtAuthenticator(() => jwt, () => seed),
          () => Promise.resolve({ user: "async-user" })
        ],
        token,
        user: "configured-user",
        pass: "secret"
      })
      const first = yield* authenticate("one")
      jwt = "second.jwt"
      token = "second.token"
      const second = yield* authenticate("two")
      expect(first.jwt).toBe("first.jwt")
      expect(second.jwt).toBe("second.jwt")
      expect(second.user).toBe("configured-user")
      expect(second.pass).toBe("secret")
      expect(second.auth_token).toBe("first.token")
      expect(second.sig).not.toBe(first.sig)
      const rotatingToken = NATSAuth.tokenAuthenticator(() => token)
      expect((yield* rotatingToken()).auth_token).toBe("second.token")
      for (
        const authenticator of [
          () => {
            throw new Error("sync rejection")
          },
          () => Promise.reject(new Error("async rejection")),
          () => Effect.fail(new NATSAuth.NATSAuthError({ message: "effect rejection" }))
        ]
      ) {
        const result = yield* NATSAuth.resolveAuthenticator(authenticator, "nonce").pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }
    }))
  it.effect("rotates credentials files without retaining or mutating caller seed bytes", () =>
    Effect.gen(function*() {
      let jwt = "first.jwt"
      const makeCredentials = () =>
        new TextEncoder().encode([
          "-----BEGIN NATS USER JWT-----",
          jwt,
          "------END NATS USER JWT------",
          "-----BEGIN USER NKEY SEED-----",
          new TextDecoder().decode(seed),
          "------END USER NKEY SEED------"
        ].join("\n"))
      const authenticate = NATSAuth.credsAuthenticator(makeCredentials)
      expect((yield* authenticate("nonce")).jwt).toBe("first.jwt")
      jwt = "second.jwt"
      expect((yield* authenticate("nonce")).jwt).toBe("second.jwt")
      expect((yield* NATSAuth.nkeyAuthenticator(seed)()).sig).toBe("")
      const failed = yield* NATSAuth.tokenAuthenticator(() => {
        throw new Error("rotation unavailable")
      })().pipe(
        Effect.result
      )
      expect(failed._tag).toBe("Failure")
    }))
  it.effect("combines JWT and credentials-file authentication", () =>
    Effect.gen(function*() {
      expect(yield* NATSAuth.jwtAuthenticator("bearer")()).toEqual({ jwt: "bearer" })
      const creds = new TextEncoder().encode([
        "-----BEGIN NATS USER JWT-----",
        "test.jwt.token",
        "------END NATS USER JWT------",
        "-----BEGIN USER NKEY SEED-----",
        new TextDecoder().decode(seed),
        "------END USER NKEY SEED------"
      ].join("\n"))
      const auth = yield* NATSAuth.credsAuthenticator(creds)("challenge")
      expect(auth.jwt).toBe("test.jwt.token")
      expect(auth.nkey).toBe(publicKey)
    }))
})
