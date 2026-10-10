import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Schedule, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

describe("AMQP public protocol parity", () => {
  it.effect("a zero-tag multiple confirm cannot confirm the next publish started by its resumed caller", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const completed = yield* Deferred.make<void>()
      const publishing = yield* Effect.gen(function*() {
        yield* channel.sendToQueue("queue", encode("first"))
        yield* channel.sendToQueue("queue", encode("second"))
        yield* Deferred.succeed(completed, undefined)
      }).pipe(Effect.exit, Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 0n, multiple: true })
      yield* Queue.take(session.publishes)
      yield* channel.prefetch(1)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      yield* session.reply(channelId, 60, 120, { deliveryTag: 2n, multiple: false, requeue: false })
      expectFailure(yield* Fiber.join(publishing), { _tag: "AMQPPublishError", outcome: "Nacked" })
    }).pipe(Effect.scoped))

  it.effect("a zero-tag multiple nack cannot reject the retry started by its resumed caller", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const completed = yield* Deferred.make<void>()
      const publishing = yield* channel.sendToQueue("queue", encode("first")).pipe(
        Effect.catchTag("AMQPPublishError", (error) => {
          expect(error.outcome).toBe("Nacked")
          return channel.sendToQueue("queue", encode("retry"))
        }),
        Effect.andThen(Deferred.succeed(completed, undefined)),
        Effect.forkChild
      )
      const channelId = yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 120, { deliveryTag: 0n, multiple: true, requeue: false })
      yield* Queue.take(session.publishes)
      yield* channel.prefetch(1)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 2n, multiple: false })
      yield* Fiber.join(publishing)
      expect(yield* Deferred.isDone(completed)).toBe(true)
    }).pipe(Effect.scoped))

  it.effect("releases a completed write's admission capacity before its caller starts the next publish", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { maxPendingOperations: 1 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      yield* session.pauseWrites
      const publishing = yield* Effect.gen(function*() {
        yield* channel.sendToQueue("queue", encode("first"))
        yield* channel.sendToQueue("queue", encode("second"))
      }).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.stalledWrites)
      yield* session.resumeWrites
      expect((yield* Fiber.join(publishing))._tag).toBe("Success")
      expect(yield* Queue.clear(session.publishes)).toHaveLength(2)
    }).pipe(Effect.scoped))

  it.effect("correlates out-of-order confirms, multiple nacks and zero-tag multiple confirms", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const publishing = []
      for (const body of ["one", "two", "three", "four"]) {
        publishing.push(yield* channel.sendToQueue("queue", encode(body)).pipe(Effect.exit, Effect.forkChild))
        yield* Queue.take(session.publishes)
      }
      const opened = yield* nextMethod(session, 20, 10)
      yield* session.reply(opened.channel, 60, 80, { deliveryTag: 3n, multiple: false })
      expect((yield* Fiber.join(publishing[2]))._tag).toBe("Success")
      yield* session.reply(opened.channel, 60, 120, { deliveryTag: 2n, multiple: true, requeue: false })
      for (const fiber of publishing.slice(0, 2)) {
        expectFailure(yield* Fiber.join(fiber), { _tag: "AMQPPublishError", outcome: "Nacked" })
      }
      yield* session.reply(opened.channel, 60, 80, { deliveryTag: 0n, multiple: true })
      expect((yield* Fiber.join(publishing[3]))._tag).toBe("Success")
      const remaining = []
      for (const body of ["five", "six"]) {
        remaining.push(yield* channel.sendToQueue("queue", encode(body)).pipe(Effect.exit, Effect.forkChild))
        yield* Queue.take(session.publishes)
      }
      yield* session.reply(opened.channel, 60, 120, { deliveryTag: 0n, multiple: true, requeue: false })
      for (const fiber of remaining) {
        expectFailure(yield* Fiber.join(fiber), { _tag: "AMQPPublishError", outcome: "Nacked" })
      }
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("does not assign late or duplicate confirms to the publish following a confirm timeout", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, confirmTimeout: "1 second" })
      const first = yield* channel.sendToQueue("queue", encode("expired")).pipe(Effect.exit, Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(first), { _tag: "AMQPPublishError", outcome: "Unknown" })
      const second = yield* channel.sendToQueue("queue", encode("next")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      // Expired and already-settled sequence numbers are ignored, not shifted onto the next waiter.
      yield* session.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* session.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* session.reply(channelId, 60, 120, { deliveryTag: 2n, multiple: false, requeue: false })
      expectFailure(yield* Fiber.join(second), { _tag: "AMQPPublishError", outcome: "Nacked" })
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("fails lost pending publishes as Unknown and sends only fresh content after recovery", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(2) })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const pending = []
      for (const body of ["lost-one", "lost-two"]) {
        pending.push(yield* channel.sendToQueue("queue", encode(body)).pipe(Effect.exit, Effect.forkChild))
        yield* Queue.take(session.publishes)
      }
      yield* session.disconnect
      for (const publishing of pending) {
        expectFailure(yield* Fiber.join(publishing), { _tag: "AMQPPublishError", outcome: "Unknown" })
      }
      yield* connection.awaitReady
      const replacement = yield* Queue.take(broker.sessions)
      const fresh = yield* channel.sendToQueue("queue", encode("fresh")).pipe(Effect.forkChild)
      const channelId = yield* Queue.take(replacement.publishes)
      yield* replacement.reply(channelId, 60, 80, { deliveryTag: 1n, multiple: false })
      yield* Fiber.join(fresh)
      yield* channel.prefetch(1)
      const frames = yield* Queue.takeAll(replacement.frames)
      expect(frames.filter((frame) => frame.type === 3).map((frame) => new TextDecoder().decode(frame.payload)))
        .toEqual(["fresh"])
      expect(yield* Queue.size(replacement.publishes)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("fails the session on a confirm beyond the highest published tag instead of shifting a waiter", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const pending = yield* channel.sendToQueue("queue", encode("pending")).pipe(Effect.exit, Effect.forkChild)
      const channelId = yield* Queue.take(session.publishes)
      yield* session.reply(channelId, 60, 80, { deliveryTag: 2n, multiple: false })
      expectFailure(yield* Fiber.join(pending), { _tag: "AMQPPublishError", outcome: "Unknown" })
      expectFailure(yield* connection.awaitReady.pipe(Effect.exit), {
        _tag: "AMQPConnectionError",
        permanent: true,
        reason: "AMQP reader failed"
      })
      yield* connection.changes.pipe(Stream.filter((state) => state.state === "Failed"), Stream.runHead)
      expect((yield* connection.state).state).toBe("Failed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("settles pending RPCs when connection.close immediately follows channel.close", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const first = yield* connection.createChannel()
      const second = yield* connection.createChannel()
      const firstRpc = yield* first.checkQueue("missing").pipe(Effect.exit, Effect.forkChild)
      const firstRequest = yield* nextMethod(session, 50, 10)
      const secondRpc = yield* second.checkQueue("pending").pipe(Effect.exit, Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      // Put both broker methods in one read to exercise their ordering at the socket boundary.
      const channelClose = yield* Codec.encodeMethod(firstRequest.channel, 20, 40, {
        replyCode: 404,
        replyText: "Queue not found",
        classId: 50,
        methodId: 10
      })
      const connectionClose = yield* Codec.encodeMethod(0, 10, 50, {
        replyCode: 403,
        replyText: "Access refused",
        classId: 0,
        methodId: 0
      })
      const bytes = new Uint8Array(channelClose.length + connectionClose.length)
      bytes.set(channelClose)
      bytes.set(connectionClose, channelClose.length)
      yield* session.send(bytes)
      expectFailure(yield* Fiber.join(firstRpc), { _tag: "AMQPChannelError", replyCode: 404 })
      expectFailure(yield* Fiber.join(secondRpc), { _tag: "AMQPConnectionError", replyCode: 403 })
      yield* nextMethod(session, 10, 51)
      yield* connection.changes.pipe(Stream.filter((state) => state.state === "Failed"), Stream.runHead)
      expectFailure(yield* connection.awaitReady.pipe(Effect.exit), { _tag: "AMQPConnectionError", permanent: true })
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("advertises protocol-correct TuneOk limits for zero and finite client/server offers", () =>
    Effect.gen(function*() {
      const cases = [
        {
          server: { frameMax: 0, channelMax: 0, heartbeat: 0 },
          client: { frameMax: 8192, channelMax: 7, heartbeat: 6 },
          expected: { frameMax: 8192, channelMax: 7, heartbeat: 6 }
        },
        {
          server: { frameMax: 16384, channelMax: 11, heartbeat: 8 },
          client: { frameMax: 0, channelMax: 0, heartbeat: 0 },
          expected: { frameMax: 16384, channelMax: 11, heartbeat: 8 }
        },
        {
          server: { frameMax: 16384, channelMax: 5, heartbeat: 8 },
          client: { frameMax: 8192, channelMax: 9, heartbeat: 4 },
          expected: { frameMax: 8192, channelMax: 5, heartbeat: 4 }
        },
        {
          server: { frameMax: 0, channelMax: 0, heartbeat: 0 },
          client: { frameMax: 0, channelMax: 0, heartbeat: 0 },
          expected: { frameMax: 0, channelMax: 0, heartbeat: 0 }
        }
      ]
      for (const scenario of cases) {
        yield* Effect.gen(function*() {
          const broker = yield* makeBroker(scenario.server)
          yield* AMQPConnection.make(broker.factory, scenario.client)
          const session = yield* Queue.take(broker.sessions)
          expect((yield* nextMethod(session, 10, 31)).fields).toEqual(scenario.expected)
        }).pipe(Effect.scoped)
      }
    }))

  it.effect("disables both heartbeat writes and the silent-peer watchdog only when both offers are zero", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ heartbeat: 0 })
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const generation = (yield* connection.state).generation
      yield* Queue.takeAll(session.frames)
      yield* TestClock.adjust("10 minutes")
      // The RPC round trip is a boundary barrier after advancing the virtual clock.
      yield* channel.prefetch(1)
      expect((yield* Queue.takeAll(session.frames)).some((frame) => frame.type === 8)).toBe(false)
      expect((yield* connection.state).state).toBe("Ready")
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("keeps the server heartbeat and watchdog active when only the client offer is zero", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ heartbeat: 2 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(session, 10, 31)).fields.heartbeat).toBe(2)
      const generation = (yield* connection.state).generation
      const heartbeat = yield* Effect.gen(function*() {
        while (true) {
          const frame = yield* Queue.take(session.frames)
          if (frame.type === 8) return frame
        }
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      expect((yield* Fiber.join(heartbeat)).channel).toBe(0)
      yield* TestClock.adjust("2 seconds")
      yield* Queue.take(broker.sessions)
      yield* connection.awaitReady
      expect((yield* connection.state).generation).toBeGreaterThan(generation)
    }).pipe(Effect.scoped))

  for (
    const scenario of [
      {
        name: "an unexpected first handshake method",
        bytes: Codec.encodeMethod(0, 10, 30, { frameMax: 131072, channelMax: 32, heartbeat: 0 })
      },
      {
        name: "an unsupported broker protocol version",
        bytes: Codec.encodeMethod(0, 10, 10, {
          versionMajor: 1,
          versionMinor: 0,
          serverProperties: {},
          mechanisms: "PLAIN",
          locales: "en_US"
        })
      }
    ]
  ) {
    it.effect(`permanently rejects ${scenario.name}`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const bytes = yield* scenario.bytes
        const factory = Effect.gen(function*() {
          const socket = yield* broker.factory
          let first = true
          return Socket.make({
            reader: Effect.gen(function*() {
              const pull = yield* Socket.readerBytes(socket)
              return {
                pull: pull.pipe(Effect.map((batch) => {
                  if (!first) return batch
                  first = false
                  return [bytes]
                })),
                upgrade: () => Effect.void
              }
            }),
            writer: socket.writer
          })
        })
        expectFailure(
          yield* AMQPConnection.make(factory, { retryConnectionSchedule: Schedule.recurs(0) }).pipe(Effect.exit),
          {
            _tag: "AMQPConnectionError",
            permanent: true
          }
        )
        const session = yield* Queue.take(broker.sessions)
        expect(
          (yield* Queue.clear(session.methods)).some((method) => method.classId === 10 && method.methodId === 11)
        )
          .toBe(false)
        expect(yield* Queue.size(broker.sessions)).toBe(0)
      }).pipe(Effect.scoped))
  }

  it.effect("fails a pending RPC on broker channel.close and restores a usable logical channel", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const generation = (yield* connection.state).generation
      const pending = yield* channel.checkQueue("missing").pipe(Effect.exit, Effect.forkChild)
      const request = yield* nextMethod(session, 50, 10)
      yield* session.reply(request.channel, 20, 40, {
        replyCode: 404,
        replyText: "Queue not found",
        classId: 50,
        methodId: 10
      })
      expectFailure(yield* Fiber.join(pending), { _tag: "AMQPChannelError", replyCode: 404 })
      expect((yield* nextMethod(session, 20, 41)).channel).toBe(request.channel)
      const reopened = yield* nextMethod(session, 20, 10)
      yield* channel.prefetch(2)
      expect((yield* nextMethod(session, 60, 10)).channel).toBe(reopened.channel)
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("uses a successfully rotated secret in the next connection handshake", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        username: "rotation-user",
        password: "initial-test-secret",
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const updating = yield* connection.updateSecret("rotated-test-secret", "rotation-test").pipe(Effect.forkChild)
      const request = yield* nextMethod(session, 10, 70)
      expect(request.fields).toEqual({ newSecret: encode("rotated-test-secret"), reason: "rotation-test" })
      yield* session.reply(0, 10, 71)
      yield* Fiber.join(updating)
      yield* connection.reconnect
      const replacement = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(replacement, 10, 11)).fields.response)
        .toEqual(encode("\0rotation-user\0rotated-test-secret"))
    }).pipe(Effect.scoped))

  it.effect("does not replace the handshake secret when rotation fails local outbound admission", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        password: "original-test-secret",
        maxPendingOperations: 1,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      yield* session.pauseWrites
      const publishing = yield* channel.sendToQueue("queue", encode("held")).pipe(Effect.forkChild)
      yield* Queue.take(session.stalledWrites)
      expectFailure(yield* connection.updateSecret("unapplied-test-secret", "not-admitted").pipe(Effect.exit), {
        _tag: "AMQPChannelError"
      })
      yield* session.resumeWrites
      yield* Fiber.join(publishing)
      yield* connection.reconnect
      const replacement = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(replacement, 10, 11)).fields.response)
        .toEqual(encode("\0guest\0original-test-secret"))
    }).pipe(Effect.scoped))
})
