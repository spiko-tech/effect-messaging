import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Latch, Queue, Schedule, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod, type Session } from "./syntheticBroker.ts"

const sendDelivery = Effect.fnUntraced(function*(session: Session, channel: number, tag: bigint) {
  yield* session.reply(channel, 60, 60, {
    consumerTag: "synthetic-consumer",
    deliveryTag: tag,
    exchange: "",
    routingKey: "queue"
  })
  yield* session.send(yield* Codec.encodeContentHeader(channel, 1n, {}))
  yield* session.send(yield* Codec.encodeFrame(3, channel, encode("x")))
})

describe("AMQP production lifecycle", () => {
  it.effect("retires the session when consumer cleanup cannot admit basic.cancel", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        maxPendingOperations: 1,
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const consumerChannel = yield* connection.createChannel()
      const publisherChannel = yield* connection.createChannel()
      const stream = yield* consumerChannel.consume("queue")
      const consuming = yield* stream.pipe(Stream.runDrain, Effect.forkChild)
      yield* nextMethod(session, 60, 20)
      const generation = (yield* connection.state).generation
      yield* session.pauseWrites
      const publishing = yield* publisherChannel.sendToQueue("queue", encode("held")).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Queue.take(session.stalledWrites)
      yield* Fiber.interrupt(consuming)
      expect((yield* connection.state).generation).toBeGreaterThan(generation)
      yield* connection.awaitReady
      yield* Fiber.join(publishing)
      const replacement = yield* Queue.take(broker.sessions)
      yield* consumerChannel.prefetch(1)
      expect(
        (yield* Queue.takeAll(replacement.methods)).some((method) => method.classId === 60 && method.methodId === 20)
      ).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("retires the session when consumer cleanup times out before acquiring the RPC slot", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        shutdownTimeout: "1 second",
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const stream = yield* channel.consume("queue")
      const consuming = yield* stream.pipe(Stream.runDrain, Effect.forkChild)
      yield* nextMethod(session, 60, 20)
      const generation = (yield* connection.state).generation
      yield* session.pauseWrites
      const control = yield* channel.prefetch(2).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.stalledWrites)
      const cancelling = yield* Fiber.interrupt(consuming).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(cancelling)
      yield* connection.awaitReady
      expect((yield* connection.state).generation).toBeGreaterThan(generation)
      expectFailure(yield* Fiber.join(control), { _tag: "AMQPConnectionError" })
      const replacement = yield* Queue.take(broker.sessions)
      yield* channel.prefetch(1)
      expect(
        (yield* Queue.takeAll(replacement.methods)).some((method) => method.classId === 60 && method.methodId === 20)
      ).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("restores an auto-delete queue owner together with a consumer-only channel", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory, {
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const owner = yield* connection.createChannel()
      const consumer = yield* connection.createChannel()
      const queue = yield* owner.assertQueue("cross-channel-auto-delete", { autoDelete: true, durable: false })
      const stream = yield* consumer.consume(queue)
      yield* stream.pipe(Stream.runDrain, Effect.forkChild)
      const registration = yield* nextMethod(session, 60, 20)
      yield* session.reply(registration.channel, 20, 40, {
        replyCode: 404,
        replyText: "Consumer-only channel retired",
        classId: 60,
        methodId: 40
      })
      const recovery = yield* Effect.raceFirst(
        Queue.take(broker.sessions).pipe(Effect.map((session) => ({ kind: "ConnectionSession", session }))),
        nextMethod(session, 20, 10).pipe(Effect.map(() => ({ kind: "ChannelSession", session })))
      )
      expect(recovery.kind).toBe("ConnectionSession")
      yield* connection.awaitReady
      const declared = yield* nextMethod(recovery.session, 50, 10)
      const consumed = yield* nextMethod(recovery.session, 60, 20)
      expect(declared.fields.queue).toBe("cross-channel-auto-delete")
      expect(consumed.fields.queue).toBe("cross-channel-auto-delete")
      expect(declared.channel).not.toBe(consumed.channel)
    }).pipe(Effect.scoped))

  it.effect("keeps deliveries settleable when basic.recover fails local outbound admission", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { maxPendingOperations: 1 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const publisher = yield* connection.createChannel()
      const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const stream = yield* channel.consume("queue")
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(deliveries, message)), Effect.forkChild)
      const registration = yield* nextMethod(session, 60, 20)
      yield* sendDelivery(session, registration.channel, 1n)
      const message = yield* Queue.take(deliveries)
      yield* session.pauseWrites
      const publishing = yield* publisher.sendToQueue("queue", encode("held")).pipe(Effect.forkChild)
      yield* Queue.take(session.stalledWrites)
      expectFailure(yield* channel.recover().pipe(Effect.exit), { _tag: "AMQPChannelError" })
      yield* session.resumeWrites
      yield* Fiber.join(publishing)
      yield* channel.ack(message)
      expect((yield* nextMethod(session, 60, 80)).fields.deliveryTag).toBe(1n)
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("removes broker-cancelled registrations while preserving in-flight settlement", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        retryConnectionSchedule: Schedule.recurs(2)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      const release = yield* Deferred.make<void>()
      const stream = yield* channel.consume("queue")
      const consuming = yield* stream.pipe(
        Stream.runForEach((message) => Queue.offer(deliveries, message).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.exit,
        Effect.forkChild
      )
      const registration = yield* nextMethod(session, 60, 20)
      yield* sendDelivery(session, registration.channel, 1n)
      const message = yield* Queue.take(deliveries)
      yield* session.reply(registration.channel, 60, 30, { consumerTag: "synthetic-consumer", noWait: false })
      yield* nextMethod(session, 60, 31)
      yield* channel.ack(message)
      expect((yield* nextMethod(session, 60, 80)).fields.deliveryTag).toBe(1n)
      yield* Deferred.succeed(release, undefined)
      expectFailure(yield* Fiber.join(consuming), { _tag: "AMQPChannelError" })
      // A cancelled tag is no longer registered: malformed post-cancel delivery must not enter a requeue loop.
      yield* sendDelivery(session, registration.channel, 2n)
      const outcome = yield* Effect.raceFirst(
        connection.changes.pipe(
          Stream.filter((state) => state.state === "Failed"),
          Stream.runHead,
          Effect.as("Retired")
        ),
        nextMethod(session, 60, 90).pipe(Effect.as("Requeued"))
      )
      expect(outcome).toBe("Retired")
      expect((yield* connection.state).state).toBe("Failed")
    }).pipe(Effect.scoped))

  for (const heldReply of [11, 21]) {
    it.effect(`does not resurrect a consumer cancelled while recovery awaits basic.${heldReply === 11 ? "qos" : "consume"}-ok`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const registering = yield* Queue.unbounded<void>()
        const gate = yield* Latch.make()
        let holdRegistration = false
        let recoveryQosReplies = 0
        const factory = Effect.gen(function*() {
          const socket = yield* broker.factory
          return Socket.make({
            reader: Effect.gen(function*() {
              const pull = yield* Socket.readerBytes(socket)
              return {
                pull: Effect.gen(function*() {
                  const batch = yield* pull
                  for (const bytes of batch) {
                    if (holdRegistration && bytes[0] === 1) {
                      const method = yield* Codec.decodeMethod(bytes.subarray(7, bytes.length - 1))
                      if (method.classId === 60 && method.methodId === heldReply) {
                        if (heldReply === 11 && ++recoveryQosReplies === 1) continue
                        yield* Queue.offer(registering, undefined)
                        yield* gate.await
                      }
                    }
                  }
                  return batch
                }).pipe(
                  Effect.catchTag(
                    "AMQPProtocolError",
                    (cause) => Effect.fail(new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }))
                  )
                ),
                upgrade: () => Effect.void
              }
            }),
            writer: socket.writer
          })
        })
        const connection = yield* AMQPConnection.make(factory, { retryConnectionSchedule: Schedule.recurs(3) })
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const stream = yield* channel.consume("queue")
        const consuming = yield* stream.pipe(Stream.runDrain, Effect.forkChild)
        yield* nextMethod(session, 60, 20)
        holdRegistration = true
        yield* session.disconnect
        yield* Queue.take(registering)
        holdRegistration = false
        const cancelling = yield* Fiber.interrupt(consuming).pipe(Effect.forkChild({ startImmediately: true }))
        yield* gate.open
        yield* Fiber.join(cancelling)
        yield* connection.awaitReady
        const recovering = yield* Queue.take(broker.sessions)
        const replacement = heldReply === 21 ? yield* Queue.take(broker.sessions) : recovering
        yield* channel.prefetch(1)
        expect(
          (yield* Queue.takeAll(replacement.methods)).some((method) => method.classId === 60 && method.methodId === 20)
        ).toBe(false)
      }).pipe(Effect.scoped))
  }
})
