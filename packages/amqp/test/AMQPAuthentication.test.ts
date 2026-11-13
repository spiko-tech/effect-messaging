import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Queue, Redacted, Result, Schedule } from "effect"
import * as Socket from "effect/socket/Socket"
import * as AMQPAuthentication from "../src/AMQPAuthentication.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import { AMQPConnectionError } from "../src/AMQPError.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import * as Protocol from "../src/internal/protocol.ts"
import { broker } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

const makeAuthenticationBroker = Effect.fnUntraced(function*(mechanisms: string, challenges = 0) {
  const incoming = yield* Queue.unbounded<Uint8Array>()
  const responses = yield* Queue.unbounded<Codec.Method>()
  const send = (methodId: number, fields: Record<string, string | number | Uint8Array> = {}) =>
    Codec.encodeMethod(0, 10, methodId, fields).pipe(Effect.flatMap((bytes) => Queue.offer(incoming, bytes)))
  const decoder = yield* Codec.makeFrameDecoder()
  let round = 0
  const next = () =>
    round < challenges
      ? send(20, { challenge: new Uint8Array([++round]) })
      : send(30, { channelMax: 32, frameMax: 131072, heartbeat: 0 })
  const write = Effect.fnUntraced(function*(chunk: Uint8Array | string | Socket.CloseEvent) {
    if (Socket.isCloseEvent(chunk)) return
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
    if (bytes === Codec.PROTOCOL_HEADER) {
      yield* send(10, { versionMajor: 0, versionMinor: 9, mechanisms, locales: "en_US" })
      return
    }
    yield* decoder.feed(
      bytes,
      Effect.fnUntraced(function*(frame: Codec.Frame) {
        const method = yield* Codec.decodeMethod(frame.payload)
        if (method.methodId === 11 || method.methodId === 21) {
          yield* Queue.offer(responses, method)
          yield* next()
        } else if (method.methodId === 40) yield* send(41)
        else if (method.methodId === 50) yield* send(51)
        return true
      })
    )
  }, Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })))
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(incoming).pipe(Effect.map((bytes): readonly [Uint8Array] => [bytes])),
      upgrade: () => Effect.void
    }),
    writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
  })
  return { factory: Effect.succeed(socket), responses }
})

describe("authentication", () => {
  it.effect("bounds built-in UTF-8 responses before allocating their encoded bytes", () =>
    Effect.gen(function*() {
      const oversized = "x".repeat(Protocol.MAX_VALUE_BYTES + 1)
      const plain = yield* Effect.exit(AMQPAuthentication.PLAIN.initialResponse("user", Redacted.make(oversized)))
      const external = yield* Effect.exit(AMQPAuthentication.external(oversized).initialResponse("", Redacted.make("")))
      for (const result of [plain, external]) {
        expect(Exit.isFailure(result) && !Exit.hasDies(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "AMQPConnectionError",
            reason: "Authentication response encoding failed",
            permanent: true
          })
        }
      }
    }))

  it.effect("rejects unknown builtin names and malformed callbacks before constructing a transport", () =>
    Effect.scoped(Effect.gen(function*() {
      let constructed = 0
      const factory = Effect.suspend(() => {
        constructed++
        return Effect.never
      })
      for (const authentication of ["TYPO", { mechanism: "PLAIN", initialResponse: "not a callback" }]) {
        const options = Object.defineProperty({}, "authentication", { value: authentication, enumerable: true })
        const result = yield* Effect.exit(AMQPConnection.make(factory, options))
        expect(Exit.isFailure(result) && !Exit.hasDies(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ _tag: "AMQPConnectionError" })
      }
      expect(constructed).toBe(0)
    })))

  it.effect("reevaluates captured prototype callbacks with rotated redacted credentials on a fresh session", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      let reads = 0
      class Mechanism implements AMQPAuthentication.Mechanism {
        readonly mechanism = "PLAIN"
        readonly passwords: Array<Redacted.Redacted<string>> = []
        get initialResponse() {
          if (++reads > 1) throw new Error("initial response reread")
          return this.respond
        }
        respond(username: string, password: Redacted.Redacted<string>) {
          expect(username).toBe("custom-user")
          this.passwords.push(password)
          return AMQPAuthentication.PLAIN.initialResponse(username, password)
        }
      }
      const authentication = new Mechanism()
      const connection = yield* AMQPConnection.make(broker.factory, {
        authentication,
        username: "custom-user",
        password: "first",
        heartbeat: 0,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const first = yield* Queue.take(broker.sessions)
      const updating = yield* connection.updateSecret("second", "rotation").pipe(Effect.forkScoped)
      yield* nextMethod(first, 10, 70)
      yield* first.reply(0, 10, 71)
      yield* Fiber.join(updating)
      yield* connection.reconnect
      const second = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(second, 10, 11)).fields.response)
        .toEqual(new TextEncoder().encode("\0custom-user\0second"))
      expect(authentication.passwords.map(Redacted.value)).toEqual(["first", "second"])
      expect(authentication.passwords.every(Redacted.isRedacted)).toBe(true)
      expect(reads).toBe(1)
    })))

  it.effect("does not turn authentication callback cancellation into an ordinary failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeAuthenticationBroker("CUSTOM")
      const started = Deferred.makeUnsafe<void>()
      const connecting = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        authentication: {
          mechanism: "CUSTOM",
          initialResponse: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(connecting)
      expect(Exit.hasInterrupts(yield* Fiber.await(connecting))).toBe(true)
    })))

  it.effect("sanitizes thrown and defecting SASL callbacks before supervisor diagnostics retain their causes", () =>
    Effect.scoped(Effect.gen(function*() {
      const sentinel = "sasl-private-secret"
      const logs: Array<string> = []
      const logger = Logger.make((event) => {
        logs.push(JSON.stringify(event.message), Cause.pretty(event.cause))
      })
      for (const phase of ["initial", "challenge"] as const) {
        for (const kind of ["throw", "die", "fail"] as const) {
          const broker = yield* makeAuthenticationBroker("CUSTOM", phase === "challenge" ? 1 : 0)
          const fail = (): Effect.Effect<Uint8Array, AMQPConnectionError> => {
            if (kind === "throw") throw new Error(sentinel)
            if (kind === "die") return Effect.die(new Error(sentinel))
            return Effect.fail(new AMQPConnectionError({ reason: sentinel, cause: new Error(sentinel) }))
          }
          const result = yield* Effect.exit(
            AMQPConnection.make(broker.factory, {
              heartbeat: 0,
              password: sentinel,
              authentication: {
                mechanism: "CUSTOM",
                initialResponse: phase === "initial" ? fail : () => Effect.succeed(new Uint8Array()),
                challenge: fail
              }
            }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
          )
          expect(Exit.isFailure(result) && !Exit.hasDies(result)).toBe(true)
          expect(JSON.stringify(result)).not.toContain(sentinel)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).not.toContain(sentinel)
        }
      }
      expect(logs.join("\n")).not.toContain(sentinel)
    })))

  it.effect("captures prototype SASL callbacks once and preserves their original receiver", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeAuthenticationBroker("CUSTOM", 2)
      let challengeReads = 0
      class Mechanism implements AMQPAuthentication.Mechanism {
        readonly mechanism = "CUSTOM"
        readonly rounds: Array<number> = []
        initialResponse(username: string, password: Redacted.Redacted<string>) {
          expect(username).toBe("custom-user")
          expect(Redacted.isRedacted(password)).toBe(true)
          expect(this.mechanism).toBe("CUSTOM")
          return Effect.succeed(new Uint8Array([0]))
        }
        get challenge() {
          if (++challengeReads > 1) throw new Error("challenge getter reread")
          return this.respond
        }
        respond(bytes: Uint8Array) {
          this.rounds.push(bytes[0] ?? 0)
          return Effect.succeed(bytes)
        }
      }
      const authentication = new Mechanism()
      yield* AMQPConnection.make(broker.factory, { authentication, username: "custom-user", heartbeat: 0 })
      expect(authentication.rounds).toEqual([1, 2])
      expect(challengeReads).toBe(1)
    })))

  it.effect("encodes builtins with exact SASL responses", () =>
    Effect.gen(function*() {
      expect(yield* AMQPAuthentication.PLAIN.initialResponse("user", Redacted.make("password")))
        .toEqual(new TextEncoder().encode("\0user\0password"))
      const table = yield* Codec.encodeFieldTable({ LOGIN: "user", PASSWORD: "password" })
      expect(yield* AMQPAuthentication.AMQPLAIN.initialResponse("user", Redacted.make("password")))
        .toEqual(table.slice(4))
      expect(yield* AMQPAuthentication.EXTERNAL.initialResponse("ignored", Redacted.make("ignored")))
        .toEqual(new Uint8Array())
    }))

  it.effect("selects advertised mechanisms and supports multiple secure rounds", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeAuthenticationBroker("PLAIN CUSTOM", 2)
      const challenges: Array<number> = []
      const authentication: AMQPAuthentication.Mechanism = {
        mechanism: "CUSTOM",
        initialResponse: (_username, password) =>
          Effect.sync(() => {
            expect(Redacted.isRedacted(password)).toBe(true)
            return new Uint8Array([0])
          }),
        challenge: (bytes) =>
          Effect.sync(() => {
            challenges.push(bytes[0] ?? 0)
            return bytes
          })
      }
      yield* AMQPConnection.make(broker.factory, { authentication, heartbeat: 0 })
      expect(challenges).toEqual([1, 2])
      expect((yield* Queue.take(broker.responses)).fields.mechanism).toBe("CUSTOM")
      expect((yield* Queue.take(broker.responses)).fields.response).toEqual(new Uint8Array([1]))
      expect((yield* Queue.take(broker.responses)).fields.response).toEqual(new Uint8Array([2]))
    })))

  it.effect("fails unavailable mechanisms locally without exposing credentials", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeAuthenticationBroker("PLAIN")
      const result = yield* Effect.result(AMQPConnection.make(broker.factory, {
        authentication: "EXTERNAL",
        password: "private-secret",
        heartbeat: 0
      }))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(JSON.stringify(result.failure)).not.toContain("private-secret")
    })))

  it.live("authenticates with real RabbitMQ AMQPLAIN", () =>
    Effect.scoped(AMQPNodeConnection.make(broker, { authentication: "AMQPLAIN" })).pipe(Effect.asVoid))
})
