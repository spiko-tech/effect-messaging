import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Schedule, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

const transportFailure = new Socket.SocketError({
  reason: new Socket.SocketCloseError({ code: 1006, closeReason: "Synthetic initial connection failure" })
})

describe("AMQP native control and faults", () => {
  it.effect("blocks publish admission without blocking control RPCs and resumes on connection.unblocked", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const blocked = yield* connection.changes.pipe(
        Stream.filter((state) => state.blocked === "memory pressure"),
        Stream.runHead,
        Effect.forkChild
      )
      yield* session.reply(0, 10, 60, { reason: "memory pressure" })
      yield* Fiber.join(blocked)
      const publishing = yield* channel.publish("", "queue", encode("held")).pipe(Effect.forkChild)
      yield* channel.prefetch(2)
      expect(yield* Queue.size(session.publishes)).toBe(0)
      yield* session.reply(0, 10, 61)
      yield* Fiber.join(publishing)
      yield* Queue.take(session.publishes)
      yield* channel.prefetch(3)
      expect((yield* connection.state).blocked).toBeUndefined()
    }).pipe(Effect.scoped))

  it.effect("acknowledges channel.flow and resumes publishes without blocking channel control", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const opened = yield* nextMethod(session, 20, 10)
      yield* session.reply(opened.channel, 20, 20, { active: false })
      expect((yield* nextMethod(session, 20, 21)).fields.active).toBe(false)
      const publishing = yield* channel.publish("", "queue", encode("held")).pipe(Effect.forkChild)
      yield* channel.prefetch(2)
      expect(yield* Queue.size(session.publishes)).toBe(0)
      yield* session.reply(opened.channel, 20, 20, { active: true })
      expect((yield* nextMethod(session, 20, 21)).fields.active).toBe(true)
      yield* Fiber.join(publishing)
      expect(yield* Queue.take(session.publishes)).toBe(opened.channel)
    }).pipe(Effect.scoped))

  it.effect("does not transmit a cancelled publish after flow resumes", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const opened = yield* nextMethod(session, 20, 10)
      yield* session.reply(opened.channel, 20, 20, { active: false })
      yield* nextMethod(session, 20, 21)
      const cancelled = yield* channel.publish("", "queue", encode("cancelled")).pipe(Effect.forkChild)
      yield* channel.prefetch(2)
      yield* Fiber.interrupt(cancelled)
      expect(yield* Queue.size(session.publishes)).toBe(0)
      yield* session.reply(opened.channel, 20, 20, { active: true })
      yield* nextMethod(session, 20, 21)
      yield* channel.publish("", "queue", encode("fresh"))
      yield* Queue.take(session.publishes)
      expect(yield* Queue.size(session.publishes)).toBe(0)
      const bodies = yield* Queue.takeAll(session.frames)
      expect(bodies.filter((frame) => frame.type === 3).map((frame) => new TextDecoder().decode(frame.payload)))
        .toEqual(["fresh"])
    }).pipe(Effect.scoped))

  it.effect("sends idle heartbeats and replaces a silent peer when the read watchdog expires", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ heartbeat: 2 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 2,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const generation = (yield* connection.state).generation
      const heartbeat = yield* Effect.gen(function*() {
        while (true) {
          const frame = yield* Queue.take(session.frames)
          if (frame.type === 8) return frame
        }
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      const frame = yield* Fiber.join(heartbeat)
      expect(frame.channel).toBe(0)
      expect(frame.payload.length).toBe(0)
      yield* TestClock.adjust("5 seconds")
      const replacement = yield* Queue.take(broker.sessions)
      yield* connection.awaitReady
      expect((yield* connection.state).generation).toBeGreaterThan(generation)
      expect(replacement).not.toBe(session)
    }).pipe(Effect.scoped))

  it.effect("recovers a broker-closed channel, topology and consumer on the same physical connection", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const queue = yield* channel.assertQueue("recovery-queue")
      yield* channel.assertExchange("recovery-exchange", "direct")
      yield* channel.bindQueue(queue, "recovery-exchange", "key")
      const messages = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const stream = yield* channel.consume(queue, { prefetch: 1 })
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(messages, message)), Effect.forkChild)
      const consuming = yield* nextMethod(session, 60, 20)
      const generation = (yield* connection.state).generation
      yield* session.reply(consuming.channel, 20, 40, {
        replyCode: 404,
        replyText: "Synthetic channel loss",
        classId: 60,
        methodId: 40
      })
      yield* nextMethod(session, 20, 41)
      yield* nextMethod(session, 20, 10)
      const replayed: Array<Codec.Method & { readonly channel: number }> = []
      const restored = yield* Effect.gen(function*() {
        while (true) {
          const method = yield* Queue.take(session.methods)
          if (method.classId === 60 && method.methodId === 20) return method
          replayed.push(method)
        }
      })
      expect(replayed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          classId: 50,
          methodId: 10,
          fields: expect.objectContaining({ queue: "recovery-queue" })
        }),
        expect.objectContaining({
          classId: 40,
          methodId: 10,
          fields: expect.objectContaining({ exchange: "recovery-exchange" })
        }),
        expect.objectContaining({
          classId: 50,
          methodId: 20,
          fields: expect.objectContaining({ queue: "recovery-queue", exchange: "recovery-exchange", routingKey: "key" })
        })
      ]))
      yield* session.reply(restored.channel, 60, 60, {
        consumerTag: "synthetic-consumer",
        deliveryTag: 1n,
        redelivered: false,
        exchange: "recovery-exchange",
        routingKey: "key"
      })
      yield* session.send(yield* Codec.encodeContentHeader(restored.channel, 5n, {}))
      yield* session.send(yield* Codec.encodeFrame(3, restored.channel, encode("after")))
      const message = yield* Queue.take(messages)
      expect(new TextDecoder().decode(message.content)).toBe("after")
      yield* channel.ack(message)
      expect((yield* nextMethod(session, 60, 80)).channel).toBe(restored.channel)
      expect(channel.connection).toBe(connection)
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("retries a transient initial transport failure before exposing a ready connection", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const attempts = yield* Queue.unbounded<number>()
      let count = 0
      const factory = Effect.gen(function*() {
        count++
        yield* Queue.offer(attempts, count)
        if (count === 1) return yield* Effect.fail(transportFailure)
        return yield* broker.factory
      })
      const connecting = yield* AMQPConnection.make(factory, {
        retryConnectionSchedule: Schedule.spaced("1 second")
      }).pipe(Effect.forkChild)
      expect(yield* Queue.take(attempts)).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(yield* Queue.take(attempts)).toBe(2)
      const connection = yield* Fiber.join(connecting)
      expect((yield* connection.state).state).toBe("Ready")
      yield* connection.createChannel()
    }).pipe(Effect.scoped))

  it.effect("reports initial retry exhaustion without creating a physical session", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      let attempts = 0
      const factory = Effect.suspend(() => {
        attempts++
        return Effect.fail(transportFailure)
      })
      const exit = yield* AMQPConnection.make(factory, {
        retryConnectionSchedule: Schedule.recurs(2)
      }).pipe(Effect.exit)
      expectFailure(exit, { _tag: "AMQPConnectionError" })
      expect(attempts).toBe(3)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("closing during reconnect backoff wakes readiness waiters and prevents restart", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        retryConnectionSchedule: Schedule.spaced("1 minute")
      })
      const session = yield* Queue.take(broker.sessions)
      const reconnecting = yield* connection.changes.pipe(
        Stream.filter((state) => state.state === "Reconnecting"),
        Stream.runHead,
        Effect.forkChild
      )
      yield* session.disconnect
      yield* Fiber.join(reconnecting)
      const waiting = yield* connection.awaitReady.pipe(Effect.exit, Effect.forkChild)
      yield* connection.close
      expectFailure(yield* Fiber.join(waiting), { _tag: "AMQPConnectionError" })
      yield* TestClock.adjust("2 minutes")
      expect((yield* connection.state).state).toBe("Closed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
      expectFailure(yield* connection.reconnect.pipe(Effect.exit), { _tag: "AMQPConnectionError" })
    }).pipe(Effect.scoped))
})
