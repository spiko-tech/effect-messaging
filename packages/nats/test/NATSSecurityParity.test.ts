import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeJWTFixture } from "./fixtures/jwt.ts"
import { makeServer } from "./server.ts"

const credentials = (jwt: string, seed: Uint8Array) =>
  new TextEncoder().encode([
    "-----BEGIN NATS USER JWT-----",
    jwt,
    "------END NATS USER JWT------",
    "-----BEGIN USER NKEY SEED-----",
    new TextDecoder().decode(seed),
    "------END USER NKEY SEED------"
  ].join("\n"))
const passwordConfig = "authorization { users: [{ user: \"alice\", password: \"secret\" }] }"
const permissionConfig =
  "authorization { users: [{ user: \"limited\", password: \"secret\", permissions: { publish: { allow: [\"allowed.>\"] }, subscribe: { allow: [\"allowed.>\", \"_INBOX.>\"] } } }] }"
const withPermission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const server = yield* makeServer({ config: permissionConfig })
    return yield* effect.pipe(
      Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "limited", pass: "secret" }))
    )
  }).pipe(Effect.scoped)
const permissionStatus = (connection: NATSConnection.NATSConnection) =>
  connection.status.pipe(
    Effect.flatMap((statuses) => statuses.pipe(Stream.filter((status) => status.type === "error"), Stream.runHead)),
    Effect.forkChild({ startImmediately: true })
  )

describe("security and authorization public laws", () => {
  it.live.each(["username password", "token"] as const)(
    "authenticates with a dynamic %s helper",
    (mode) =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config: mode === "token" ? "authorization { token: \"secret\" }" : passwordConfig
        })
        const authenticator = mode === "token"
          ? NATSAuth.tokenAuthenticator(() => "secret")
          : NATSAuth.usernamePasswordAuthenticator(() => "alice", () => "secret")
        const connection = yield* Node.make({ servers: server.url, authenticator })
        yield* connection.flush
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live(
    "cross-account service requests expose caller metadata and account permissions",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config: `accounts {
          S { users: [{ user: "s", password: "s", permissions: { subscribe: ["q.>", "_INBOX.>"], publish: "$SYS.REQ.USER.INFO", allow_responses: true } }], exports: [{ service: "q.>" }] }
          A { users: [{ user: "a", password: "a" }], imports: [{ service: { subject: "q.>", account: "S" } }] }
        }`
        })
        const service = yield* Node.make({ servers: server.url, user: "s", pass: "s", debug: true })
        const response = yield* service.request("$SYS.REQ.USER.INFO")
        const context = yield* response.decode(Schema.Struct({
          data: Schema.Struct({
            user: Schema.String,
            account: Schema.String,
            permissions: Schema.Struct({
              publish: Schema.Struct({ allow: Schema.Array(Schema.String) }),
              subscribe: Schema.Struct({ allow: Schema.Array(Schema.String) }),
              responses: Schema.Struct({ max: Schema.Number })
            })
          })
        }))
        expect(context.data.user).toBe("s")
        expect(context.data.account).toBe("S")
        expect(context.data.permissions.publish.allow).toContain("$SYS.REQ.USER.INFO")
        expect(context.data.permissions.subscribe.allow).toEqual(["q.>", "_INBOX.>"])
        expect(context.data.permissions.responses.max).toBe(1)
        const subscription = yield* service.subscribe("q.>")
        const handler = yield* subscription.stream.pipe(
          Stream.take(1),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              expect(Option.getOrThrow(yield* message.requestInfo).acc).toBe("A")
              expect(yield* message.respond()).toBe(true)
            })
          ),
          Effect.forkChild({ startImmediately: true })
        )
        yield* service.flush
        const caller = yield* Node.make({ servers: server.url, user: "a", pass: "a" })
        yield* caller.request("q.hello")
        yield* Fiber.join(handler)
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live.each(["missing user", "wrong password", "missing token", "wrong token"] as const)(
    "rejects %s authentication",
    (mode) =>
      Effect.gen(function*() {
        const tokenMode = mode.includes("token")
        const server = yield* makeServer({ config: tokenMode ? "authorization { token: \"secret\" }" : passwordConfig })
        const options: NATSOptions.NodeConnectionOptions = {
          servers: server.url,
          reconnect: false,
          ...(mode === "wrong password" ? { user: "alice", pass: "wrong" } : {}),
          ...(mode === "wrong token" ? { token: "wrong" } : {})
        }
        const result = yield* Effect.scoped(Node.make(options)).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.code).toBe("authorization")
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("preserves non-ASCII passwords through CONNECT JSON", () =>
    Effect.gen(function*() {
      const pass = "§12§12§12"
      const server = yield* makeServer({
        config: `authorization { users: [{ user: "alice", password: ${JSON.stringify(pass)} }] }`
      })
      const connection = yield* Node.make({ servers: server.url, user: "alice", pass })
      yield* connection.flush
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("maps a thrown custom authenticator to a typed connection failure", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ config: passwordConfig })
      const result = yield* Effect.scoped(Node.make({
        servers: server.url,
        authenticator: () => {
          throw new Error("user code exploded")
        }
      })).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("authorization")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.effect.each([["", ""], ["jwt", ""], ["", "seed"]] as const)(
    "rejects incomplete credential fields %j",
    ([jwt, seed]) =>
      Effect.gen(function*() {
        const validSeed = "SUAIBDPBAUTWCWBKIO6XHQNINK5FWJW4OHLXC3HQ2KFE4PEJUA44CNHTC4"
        const result = yield* NATSAuth.credsAuthenticator(
          credentials(jwt, new TextEncoder().encode(seed === "seed" ? validSeed : seed))
        )().pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      })
  )
  it.live.each([false, true])(
    "subscription denial closes only the subscription and reports callback=%s",
    (callback) =>
      withPermission(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const status = yield* permissionStatus(connection)
        const reported = yield* Deferred.make<string>()
        const sub = yield* connection.subscribe(
          "forbidden.sub",
          callback ?
            {
              callback: (error) => {
                if (Option.isSome(error)) Deferred.doneUnsafe(reported, Effect.succeed(error.value.reason))
              }
            } :
            {}
        )
        const failure = callback
          ? yield* Deferred.await(reported)
          : (yield* Stream.runCollect(sub.stream).pipe(Effect.flip)).reason
        expect(failure).toMatch(/permissions/i)
        expect(Option.isSome(yield* sub.closed)).toBe(true)
        expect(yield* sub.isClosed).toBe(true)
        expect(Option.getOrThrow(yield* Fiber.join(status)).type).toBe("error")
        expect(yield* connection.isClosed).toBe(false)
        yield* connection.flush
        yield* sub.unsubscribe()
        yield* connection.close
        expect(yield* connection.closed).toEqual(Option.none())
      })),
    { timeout: 30_000 }
  )
  it.live(
    "publication denial emits an error status and leaves the connection usable",
    () =>
      withPermission(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const status = yield* permissionStatus(connection)
        yield* connection.publish("forbidden.publish")
        const event = Option.getOrThrow(yield* Fiber.join(status))
        expect(event.type).toBe("error")
        if (event.type === "error") {
          expect(event.error).toHaveProperty("reason", expect.stringMatching(/permissions.*publish/i))
        }
        expect(yield* connection.isClosed).toBe(false)
        yield* connection.flush
      })),
    { timeout: 30_000 }
  )
  it.live.each([false, true])(
    "request publication denial fails promptly and reports subject, noMux=%s",
    (noMux) =>
      withPermission(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const status = yield* permissionStatus(connection)
        const reply = "_INBOX.native.denied"
        const unrelated = yield* connection.subscribe(reply)
        const failure = yield* connection.request("forbidden.request", "", {
          noMux,
          ...(noMux ? { reply } : {}),
          timeout: 5000
        }).pipe(Effect.flip, Effect.timeout("1 second"))
        expect(failure.reason).toMatch(/permissions.*publish/i)
        expect(failure.subject).toBe("forbidden.request")
        expect(Option.getOrThrow(yield* Fiber.join(status)).type).toBe("error")
        expect(yield* unrelated.isClosed).toBe(false)
        expect(yield* connection.isClosed).toBe(false)
        yield* unrelated.unsubscribe()
      })),
    { timeout: 30_000 }
  )
  it.live(
    "a permitted inbox prefix distinguishes mux subscription denial from no responders",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config: "authorization { users: [{ user: \"a\", password: \"a\", permissions: { subscribe: [\"q.>\"] } }] }"
        })
        for (const inboxPrefix of ["_INBOX", "q"]) {
          yield* Effect.scoped(Effect.gen(function*() {
            const connection = yield* Node.make({ servers: server.url, user: "a", pass: "a", inboxPrefix })
            const failure = yield* connection.request("q").pipe(Effect.flip)
            expect(failure.reason).toMatch(inboxPrefix === "q" ? /no responders/i : /permissions.*subscription/i)
            if (inboxPrefix !== "q") {
              expect(failure.code).toBe("permissions")
              expect(failure.cause).toMatchObject({ reason: expect.stringMatching(/permissions.*subscription/i) })
            }
            expect(yield* connection.isClosed).toBe(false)
          }))
        }
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live(
    "denied subscriptions are discarded and can be independently recreated",
    () =>
      withPermission(Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        for (let index = 0; index < 2; index++) {
          const sub = yield* connection.subscribe("forbidden.repeat")
          expect((yield* Stream.runCollect(sub.stream).pipe(Effect.result))._tag).toBe("Failure")
          expect(yield* sub.isClosed).toBe(true)
          expect(yield* sub.getPending).toBe(0)
          expect(yield* connection.isClosed).toBe(false)
        }
      })),
    { timeout: 30_000 }
  )
  it.live(
    "queue permission errors preserve an authorized subscription on the same subject",
    () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config: "authorization { users: [{ user: \"a\", password: \"a\", permissions: { subscribe: [\"q A\"] } }] }"
        })
        const connection = yield* Node.make({ servers: server.url, user: "a", pass: "a" })
        const allowed = yield* connection.subscribe("q", { queue: "A", max: 1 })
        const denied = yield* connection.subscribe("q", { queue: "bad" })
        const failure = yield* Stream.runCollect(denied.stream).pipe(Effect.flip)
        expect(failure.reason).toContain("queue \"bad\"")
        expect(yield* allowed.isClosed).toBe(false)
        yield* connection.publish("q", "allowed")
        expect(yield* allowed.stream.pipe(Stream.mapEffect((message) => message.string), Stream.runCollect)).toEqual([
          "allowed"
        ])
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live.each([false, true])(
    "repeated authorization failures obey ignoreAuthErrorAbort=%s",
    (ignoreAuthErrorAbort) =>
      Effect.gen(function*() {
        const server = yield* makeServer({ config: passwordConfig })
        let pass = "secret"
        const connection = yield* Node.make({
          servers: server.url,
          authenticator: NATSAuth.usernamePasswordAuthenticator("alice", () => pass),
          ignoreAuthErrorAbort,
          maxReconnectAttempts: 4,
          reconnectTimeWait: 1,
          reconnectJitter: 0
        })
        const errors = yield* connection.status.pipe(
          Effect.flatMap((statuses) =>
            statuses.pipe(Stream.filter((status) => status.type === "error"), Stream.runCollect)
          ),
          Effect.forkChild({ startImmediately: true })
        )
        pass = "wrong"
        const reconnectFailure = yield* connection.reconnect.pipe(Effect.flip)
        expect(reconnectFailure).toMatchObject({ _tag: "NATSConnectionError", code: "closed" })
        const closed = yield* connection.closed
        expect(Option.isSome(closed)).toBe(true)
        if (Option.isSome(closed)) {
          expect(closed.value.reason).toContain("Authorization Violation")
          expect(closed.value.code).toBe(ignoreAuthErrorAbort ? "authorization" : "authorization_permanent")
          expect(reconnectFailure.cause).toBe(closed.value)
        }
        expect(yield* Fiber.join(errors)).toHaveLength(ignoreAuthErrorAbort ? 4 : 2)
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live(
    "custom and composite authenticators retain all credentials through a broker handshake",
    () =>
      Effect.gen(function*() {
        const auth = yield* makeJWTFixture()
        const server = yield* makeServer({ config: auth.config, jetstream: false })
        for (
          const authenticator of [
            (nonce?: string) =>
              NATSAuth.nkeyAuthenticator(auth.first.seed)(nonce).pipe(
                Effect.map((signed) => ({ ...signed, jwt: auth.firstJWT }))
              ),
            [
              NATSAuth.credsAuthenticator(credentials(auth.firstJWT, auth.first.seed)),
              NATSAuth.nkeyAuthenticator(auth.first.seed)
            ]
          ]
        ) {
          yield* Effect.scoped(
            Node.make({ servers: server.url, authenticator, user: "a", pass: "secret", token: "mytoken" }).pipe(
              Effect.flatMap((connection) => connection.flush)
            )
          )
        }
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live.each(["user", "account"] as const)(
    "notifies %s authentication expiration and closes without reconnect",
    (kind) =>
      Effect.gen(function*() {
        const auth = yield* makeJWTFixture(false, { [kind]: 3 })
        const server = yield* makeServer({ config: auth.config, jetstream: false })
        const connection = yield* Node.make({
          servers: server.url,
          reconnect: false,
          authenticator: NATSAuth.jwtAuthenticator(auth.firstJWT, auth.first.seed)
        })
        const errors = yield* connection.status.pipe(
          Effect.flatMap((statuses) =>
            statuses.pipe(Stream.filter((status) => status.type === "error"), Stream.runCollect)
          ),
          Effect.forkChild({ startImmediately: true })
        )
        const failure = Option.getOrThrow(yield* connection.closed.pipe(Effect.timeout("5 seconds")))
        expect(failure.code).toBe("authorization")
        expect(failure.reason.toLowerCase()).toContain(`${kind} authentication expired`)
        expect((yield* Fiber.join(errors)).length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("renews JWTs across four authentication-expiry reconnects", () =>
    Effect.gen(function*() {
      const auth = yield* makeJWTFixture(false, { user: 2 })
      const server = yield* makeServer({ config: auth.config, jetstream: false })
      const connection = yield* Node.make({
        servers: server.url,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1,
        reconnectJitter: 0,
        authenticator: (nonce) =>
          Effect.gen(function*() {
            const token = yield* Effect.promise(auth.renewUserJWT)
            return yield* NATSAuth.jwtAuthenticator(token, auth.first.seed)(nonce)
          })
      })
      let expirations = 0
      const recovered = yield* connection.status.pipe(
        Effect.flatMap((statuses) =>
          statuses.pipe(
            Stream.tap((status) =>
              Effect.sync(() => {
                if (status.type === "error") expirations++
              })
            ),
            Stream.filter((status) => status.type === "reconnect"),
            Stream.take(4),
            Stream.runCollect
          )
        ),
        Effect.forkChild({ startImmediately: true })
      )
      expect(yield* Fiber.join(recovered).pipe(Effect.timeout("12 seconds"))).toHaveLength(4)
      expect(expirations).toBeGreaterThanOrEqual(4)
      expect(yield* connection.isClosed).toBe(false)
      yield* connection.flush
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
