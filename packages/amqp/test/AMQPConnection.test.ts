import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import { expectFailure } from "./assertions.ts"
import { broker, testConnection } from "./dependencies.ts"
import { makeBroker } from "./syntheticBroker.ts"

describe("AMQPConnection", () => {
  it.effect("preserves the public connection and channel type identities", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      expect(AMQPConnection.TypeId).toBe(Symbol.for("@effect-messaging/amqp/AMQPConnection"))
      expect(AMQPChannel.TypeId).toBe(Symbol.for("@effect-messaging/amqp/AMQPChannel"))
      expect(connection[AMQPConnection.TypeId]).toBe(AMQPConnection.TypeId)
      expect(channel[AMQPChannel.TypeId]).toBe(AMQPChannel.TypeId)
    }).pipe(Effect.scoped))

  it.effect("rejects invalid protocol and resource limits before acquiring a transport", () =>
    Effect.gen(function*() {
      let attempts = 0
      const transport = Effect.sync(() => {
        attempts++
      }).pipe(
        Effect.andThen(Effect.die(new Error("Invalid options must not acquire a socket")))
      )
      const configurations: Array<AMQPConnection.AMQPConnectionOptions> = [
        { heartbeat: -1 },
        { heartbeat: 65536 },
        { frameMax: 4095 },
        { channelMax: 65536 },
        { maxMessageBytes: 0 },
        { maxOutboundBytes: 0 },
        { maxPendingOperations: 0 }
      ]
      for (const options of configurations) {
        expectFailure(yield* AMQPConnection.make(transport, options).pipe(Effect.scoped, Effect.exit), {
          _tag: "AMQPConnectionError",
          permanent: true
        })
      }
      expect(attempts).toBe(0)
    }))

  it.live("exposes broker properties and a ready generation", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      yield* connection.awaitReady
      expect(yield* connection.serverProperties).toMatchObject({ product: "RabbitMQ" })
      expect(yield* connection.state).toMatchObject({ state: "Ready" })
    }).pipe(Effect.provide(testConnection)))

  it.live("reports recovery and advances generations on repeated reconnect", () =>
    Effect.gen(function*() {
      const connection = yield* AMQPConnection.AMQPConnection
      const initial = yield* connection.state
      const changes = yield* connection.changes.pipe(
        Stream.filter((state) => state.state === "Ready" && state.generation > initial.generation),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* connection.reconnect
      const states = yield* Fiber.join(changes)
      expect(states[0]?.generation).toBeGreaterThan(initial.generation)
      const recovered = yield* connection.state
      yield* connection.reconnect
      expect((yield* connection.state).generation).toBeGreaterThan(recovered.generation)
      expect(yield* connection.serverProperties).toMatchObject({ product: "RabbitMQ" })
    }).pipe(Effect.provide(testConnection)))

  it.live(
    "does not replace an explicitly empty URL password with guest credentials",
    () =>
      Effect.forEach([
        `amqp://guest:@${broker.hostname}:${broker.port}`,
        ` am\nqp://guest:@${broker.hostname}:${broker.port} `
      ], (url) =>
        AMQPNodeConnection.make(url).pipe(
          Effect.scoped,
          Effect.exit,
          Effect.map((exit) => expectFailure(exit, { _tag: "AMQPConnectionError", permanent: true }))
        )),
    { timeout: 15000 }
  )

  it.live(
    "fails invalid authentication permanently rather than retrying forever",
    () =>
      AMQPNodeConnection.make({ ...broker, password: "invalid-effect-messaging-password" }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.map((exit) => expectFailure(exit, { _tag: "AMQPConnectionError", permanent: true }))
      ),
    { timeout: 15000 }
  )
})
