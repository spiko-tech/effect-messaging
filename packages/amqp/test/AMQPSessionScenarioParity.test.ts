import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Schedule, Scope, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import { AMQPProtocolError } from "../src/AMQPError.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { encode } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"
import type * as SyntheticBroker from "./syntheticBroker.ts"

// This adapter controls only the independent peer's incoming bytes, never client RPC slots or state.
const filterReplies = (
  factory: AMQPConnection.SocketFactory,
  transform: (frame: Codec.Frame, method: Codec.Method) => Effect.Effect<Uint8Array | undefined, AMQPProtocolError>
) =>
  Effect.gen(function*() {
    const socket = yield* factory
    return Socket.make({
      reader: Effect.gen(function*() {
        const pull = yield* Socket.readerBytes(socket)
        const decoder = yield* Codec.makeFrameDecoder()
        return {
          pull: pull.pipe(
            Effect.flatMap(Effect.fnUntraced(function*(batch) {
              const result: Array<Uint8Array> = []
              for (const bytes of batch) {
                yield* decoder.feed(
                  bytes,
                  Effect.fnUntraced(function*(frame) {
                    if (frame.type !== 1) {
                      return yield* Effect.fail(
                        new AMQPProtocolError({ reason: "Scenario peer expects method replies only" })
                      )
                    }
                    const replacement = yield* transform(frame, yield* Codec.decodeMethod(frame.payload))
                    if (replacement !== undefined) result.push(replacement)
                    return true
                  })
                )
              }
              const bytes = new Uint8Array(result.reduce((length, chunk) => length + chunk.length, 0))
              let offset = 0
              for (const chunk of result) {
                bytes.set(chunk, offset)
                offset += chunk.length
              }
              return [bytes] as const
            })),
            Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }))
          ),
          upgrade: () => Effect.void
        }
      }).pipe(Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }))),
      writer: socket.writer
    })
  })

const originalReply = (frame: Codec.Frame, method: Codec.Method) =>
  Codec.encodeMethod(frame.channel, method.classId, method.methodId, method.fields)

const waitState = (connection: AMQPConnection.AMQPConnection, state: AMQPConnection.ConnectionState["state"]) =>
  connection.changes.pipe(
    Stream.filter((value) => value.state === state),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  )

describe("AMQP public session scenario parity", () => {
  it.effect("CN12 guardrail reentrant close from a failed RPC acknowledges broker 403 before shutdown", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { shutdownTimeout: "2 seconds" })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const generation = (yield* connection.state).generation
      const caller = yield* Effect.gen(function*() {
        expectFailure(yield* channel.checkQueue("pending").pipe(Effect.exit), {
          _tag: "AMQPConnectionError",
          replyCode: 403
        })
        // The failed RPC resumes this caller while the broker acknowledgement is still pending.
        yield* connection.close
      }).pipe(Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      yield* session.reply(0, 10, 50, { replyCode: 403, replyText: "Reentrant shutdown", classId: 50, methodId: 10 })
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(caller)
      expect((yield* Queue.clear(session.methods)).some((method) => method.classId === 10 && method.methodId === 51))
        .toBe(true)
      expect((yield* connection.state).state).toBe("Closed")
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CN12 guardrail scope closure from a failed RPC preserves the broker close acknowledgement", () =>
    Effect.gen(function*() {
      const owner = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { shutdownTimeout: "2 seconds" }).pipe(
        Effect.provideService(Scope.Scope, owner)
      )
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel().pipe(Effect.provideService(Scope.Scope, owner))
      const generation = (yield* connection.state).generation
      const caller = yield* Effect.gen(function*() {
        expectFailure(yield* channel.checkQueue("pending").pipe(Effect.exit), {
          _tag: "AMQPConnectionError",
          replyCode: 403
        })
        yield* Scope.close(owner, Exit.void)
      }).pipe(Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      yield* session.reply(0, 10, 50, { replyCode: 403, replyText: "Owner scope closing", classId: 50, methodId: 10 })
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(caller)
      expect((yield* Queue.clear(session.methods)).some((method) => method.classId === 10 && method.methodId === 51))
        .toBe(true)
      expect((yield* connection.state).state).toBe("Closed")
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH05 guardrail reader disconnect stays responsive while broker CloseOk writer is stalled", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { shutdownTimeout: "2 seconds" })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const publishing = yield* channel.sendToQueue("queue", encode("pending")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      const rpc = yield* channel.checkQueue("pending").pipe(Effect.exit, Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      yield* session.pauseWrites
      yield* session.reply(0, 10, 50, { replyCode: 403, replyText: "Broker refused", classId: 50, methodId: 10 })
      yield* Queue.take(session.stalledWrites)
      expectFailure(yield* Fiber.join(rpc), { _tag: "AMQPConnectionError", replyCode: 403 })
      yield* session.disconnect
      // No TestClock advancement: reader loss must retire the stalled acknowledgement immediately.
      const failed = yield* waitState(connection, "Failed")
      expect(failed.error).toEqual(expect.objectContaining({
        _tag: "AMQPConnectionError",
        replyCode: 403,
        reason: "Broker refused",
        classId: 50,
        methodId: 10,
        permanent: true
      }))
      expectFailure(yield* Fiber.join(publishing), {
        _tag: "AMQPPublishError",
        outcome: "Unknown",
        cause: expect.objectContaining({ _tag: "AMQPConnectionError", replyCode: 403, reason: "Broker refused" })
      })
      const closing = yield* connection.close.pipe(Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(closing)
      expect((yield* connection.state).state).toBe("Closed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH05 guardrail stalled CloseOk expires at one second retaining broker failure without channel reuse", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ channelMax: 1 })
      const connection = yield* AMQPConnection.make(broker.factory, { shutdownTimeout: "2 seconds" })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const generation = (yield* connection.state).generation
      const publishing = yield* channel.sendToQueue("queue", encode("pending")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      const states = yield* Queue.unbounded<AMQPConnection.ConnectionState>()
      yield* connection.changes.pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.clear(states)
      const caller = yield* Effect.gen(function*() {
        expectFailure(yield* channel.checkQueue("pending").pipe(Effect.exit), {
          _tag: "AMQPConnectionError",
          replyCode: 403
        })
        // Cleanup of a failed channel must not supersede the outstanding broker acknowledgement.
        yield* channel.close
      }).pipe(Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      yield* session.pauseWrites
      yield* session.reply(0, 10, 50, {
        replyCode: 403,
        replyText: "Deadline broker refusal",
        classId: 50,
        methodId: 10
      })
      const stalled = yield* Queue.take(session.stalledWrites)
      const bytes = typeof stalled === "string" ? encode(stalled) : stalled
      const decoder = yield* Codec.makeFrameDecoder()
      const frames: Array<Codec.Frame> = []
      yield* decoder.feed(bytes, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
          return true
        }))
      expect(frames).toHaveLength(1)
      expect(frames[0].channel).toBe(0)
      expect(yield* Codec.decodeMethod(frames[0].payload)).toEqual(
        expect.objectContaining({ classId: 10, methodId: 51 })
      )
      yield* Fiber.join(caller)
      expectFailure(yield* Fiber.join(publishing), {
        _tag: "AMQPPublishError",
        outcome: "Unknown",
        cause: expect.objectContaining({
          _tag: "AMQPConnectionError",
          replyCode: 403,
          reason: "Deadline broker refusal"
        })
      })
      expect((yield* connection.state).state).not.toBe("Failed")
      yield* TestClock.adjust("1 second")
      const failed = yield* waitState(connection, "Failed")
      expect(failed.generation).toBe(generation)
      expect(failed.error).toEqual(expect.objectContaining({
        _tag: "AMQPConnectionError",
        replyCode: 403,
        reason: "Deadline broker refusal",
        classId: 50,
        methodId: 10,
        permanent: true
      }))
      expectFailure(yield* connection.createChannel().pipe(Effect.exit), {
        _tag: "AMQPConnectionError",
        replyCode: 403
      })
      yield* session.resumeWrites
      yield* Effect.yieldNow
      expect((yield* Queue.clear(states)).some((state) => state.state === "Ready")).toBe(false)
      expect((yield* Queue.clear(session.methods)).some((method) => method.classId === 20 && method.methodId === 10))
        .toBe(false)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CN13 guardrail broker 530 during ConnectionOpen writes CloseOk before acquisition scope cleanup", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const peers = yield* Queue.unbounded<SyntheticBroker.Session>()
      const acknowledgedAtRetirement = yield* Deferred.make<boolean>()
      const replies = filterReplies(broker.factory, (frame, method) =>
        method.classId === 10 && method.methodId === 41
          ? Codec.encodeMethod(0, 10, 50, { replyCode: 530, replyText: "Vhost forbidden", classId: 10, methodId: 40 })
          : originalReply(frame, method))
      const factory = Effect.gen(function*() {
        const socket = yield* replies
        const session = yield* Queue.take(broker.sessions)
        yield* Queue.offer(peers, session)
        return Socket.make({
          reader: Effect.acquireRelease(socket.reader, () =>
            Effect.gen(function*() {
              const methods = yield* Queue.clear(session.methods)
              yield* Deferred.succeed(
                acknowledgedAtRetirement,
                methods.some((method) => method.channel === 0 && method.classId === 10 && method.methodId === 51)
              )
            })),
          writer: socket.writer
        })
      })
      const opening = yield* AMQPConnection.make(factory, { retryConnectionSchedule: Schedule.recurs(0) }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.forkChild
      )
      yield* Queue.take(peers)
      expectFailure(yield* Fiber.join(opening), {
        _tag: "AMQPConnectionError",
        replyCode: 530,
        reason: "Vhost forbidden",
        classId: 10,
        methodId: 40,
        permanent: true
      })
      expect(yield* Deferred.await(acknowledgedAtRetirement)).toBe(true)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
      expect(yield* Queue.size(peers)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("R-B04 close with pending channel work rejects new admission immediately and settles at deadline", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        shutdownTimeout: "1 second",
        retryConnectionSchedule: Schedule.recurs(1)
      })
      yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      yield* connection.reconnect
      const session = yield* Queue.take(broker.sessions)
      const publishing = yield* channel.sendToQueue("queue", encode("admitted")).pipe(Effect.exit, Effect.forkChild)
      yield* Queue.take(session.publishes)
      const rpc = yield* channel.checkQueue("pending").pipe(Effect.exit, Effect.forkChild)
      yield* nextMethod(session, 50, 10)
      const closing = yield* connection.close.pipe(Effect.forkChild)
      yield* waitState(connection, "Closing")
      // Unlike the reference, native explicit shutdown closes admission before draining existing work.
      expectFailure(yield* channel.sendToQueue("queue", encode("not-admitted")).pipe(Effect.exit), {
        _tag: "AMQPPublishError",
        outcome: "NotSent"
      })
      expectFailure(yield* connection.createChannel().pipe(Effect.exit), { _tag: "AMQPConnectionError" })
      expect(yield* Queue.size(session.publishes)).toBe(0)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closing)
      expectFailure(yield* Fiber.join(publishing), { _tag: "AMQPPublishError", outcome: "Unknown" })
      expectFailure(yield* Fiber.join(rpc), { _tag: "AMQPChannelError", reason: "Channel closed" })
      expect((yield* connection.state).state).toBe("Closed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CN12 client and server ConnectionClose crossing acknowledges without restarting", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const factory = filterReplies(broker.factory, (frame, method) =>
        method.classId === 10 && method.methodId === 51
          ? Codec.encodeMethod(0, 10, 50, { replyCode: 320, replyText: "Crossing close", classId: 0, methodId: 0 })
          : originalReply(frame, method))
      const connection = yield* AMQPConnection.make(factory, { shutdownTimeout: "1 second" })
      const session = yield* Queue.take(broker.sessions)
      const generation = (yield* connection.state).generation
      const closing = yield* connection.close.pipe(Effect.forkChild)
      yield* nextMethod(session, 10, 50)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closing)
      expect((yield* Queue.clear(session.methods)).some((method) => method.classId === 10 && method.methodId === 51))
        .toBe(true)
      expect((yield* connection.state).state).toBe("Closed")
      expect((yield* connection.state).generation).toBe(generation)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CN16 blocked connection close with withheld CloseOk obeys shutdown timeout", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const factory = filterReplies(broker.factory, (frame, method) =>
        method.classId === 10 && method.methodId === 51 ? Effect.succeed(undefined) : originalReply(frame, method))
      const connection = yield* AMQPConnection.make(factory, { shutdownTimeout: "1 second" })
      const session = yield* Queue.take(broker.sessions)
      yield* session.reply(0, 10, 60, { reason: "Resource alarm" })
      yield* connection.changes.pipe(
        Stream.filter((state) =>
          state.blocked === "Resource alarm"
        ),
        Stream.runHead
      )
      const done = yield* Deferred.make<void>()
      const closing = yield* connection.close.pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.forkChild)
      yield* nextMethod(session, 10, 50)
      expect(yield* Deferred.isDone(done)).toBe(false)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closing)
      expect((yield* connection.state).state).toBe("Closed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH02 channel open rejects CloseOk in place of OpenOk", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const factory = filterReplies(broker.factory, (frame, method) =>
        method.classId === 20 && method.methodId === 11
          ? Codec.encodeMethod(frame.channel, 20, 41)
          : originalReply(frame, method))
      const connection = yield* AMQPConnection.make(factory, { shutdownTimeout: "1 second" })
      const session = yield* Queue.take(broker.sessions)
      const opening = yield* connection.createChannel().pipe(Effect.exit, Effect.forkChild)
      yield* nextMethod(session, 20, 10)
      yield* waitState(connection, "Failed")
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(opening), { _tag: "AMQPConnectionError", permanent: true })
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH05 client channel close crossing server connection close settles without restart", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const factory = filterReplies(broker.factory, (frame, method) =>
        method.classId === 20 && method.methodId === 41
          ? Codec.encodeMethod(0, 10, 50, {
            replyCode: 403,
            replyText: "Connection closing",
            classId: 20,
            methodId: 40
          })
          : originalReply(frame, method))
      const connection = yield* AMQPConnection.make(factory, {
        shutdownTimeout: "1 second",
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const closing = yield* channel.close.pipe(Effect.forkChild)
      yield* nextMethod(session, 20, 40)
      yield* waitState(connection, "Failed")
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closing)
      expect((yield* Queue.clear(session.methods)).some((method) => method.classId === 10 && method.methodId === 51))
        .toBe(true)
      expectFailure(yield* connection.awaitReady.pipe(Effect.exit), { _tag: "AMQPConnectionError", replyCode: 403 })
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH07 three concurrent prefetch RPCs serialize behind peer reply gates", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      let replyPermits = 0
      const withheld = yield* Queue.unbounded<Codec.Frame>()
      const factory = filterReplies(broker.factory, (frame, method) => {
        if (method.classId === 60 && method.methodId === 11) {
          if (replyPermits === 0) {
            Queue.offerUnsafe(withheld, frame)
            return Effect.succeed(undefined)
          }
          replyPermits--
        }
        return originalReply(frame, method)
      })
      const connection = yield* AMQPConnection.make(factory)
      const session = yield* Queue.take(broker.sessions)
      const opening = yield* connection.createChannel().pipe(Effect.forkChild)
      const initial = yield* nextMethod(session, 60, 10)
      // Public channel initialization also establishes its default QoS.
      yield* Queue.take(withheld)
      replyPermits = 1
      yield* session.reply(initial.channel, 60, 11)
      const channel = yield* Fiber.join(opening)
      const first = yield* channel.prefetch(1).pipe(Effect.forkChild)
      const request = yield* nextMethod(session, 60, 10)
      expect(request.fields.prefetchCount).toBe(1)
      yield* Queue.take(withheld)
      const second = yield* channel.prefetch(2).pipe(Effect.forkChild({ startImmediately: true }))
      const third = yield* channel.prefetch(3).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(yield* Queue.size(session.methods)).toBe(0)
      replyPermits = 1
      yield* session.reply(request.channel, 60, 11)
      yield* Fiber.join(first)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(2)
      yield* Queue.take(withheld)
      expect(yield* Queue.size(session.methods)).toBe(0)
      replyPermits = 1
      yield* session.reply(request.channel, 60, 11)
      yield* Fiber.join(second)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(3)
      yield* Queue.take(withheld)
      replyPermits = 1
      yield* session.reply(request.channel, 60, 11)
      yield* Fiber.join(third)
    }).pipe(Effect.scoped))

  it.effect("CH08 unexpected recover reply fails the RPC and session permanently", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const recovering = yield* channel.recover().pipe(Effect.exit, Effect.forkChild)
      const request = yield* nextMethod(session, 60, 110)
      // Valid QosOk, but the outstanding method is Recover, whose reply is RecoverOk.
      yield* session.reply(request.channel, 60, 11)
      expectFailure(yield* Fiber.join(recovering), { _tag: "AMQPConnectionError", permanent: true })
      yield* waitState(connection, "Failed")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("R-B21/C-T65/C-T66 channelMax one concurrent exhaustion preserves QoS and safely reuses closed number", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ channelMax: 1 })
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const attempts = yield* Effect.forEach([1, 2, 3], () => connection.createChannel().pipe(Effect.exit), {
        concurrency: "unbounded"
      })
      for (const exit of attempts) expectFailure(exit, { _tag: "AMQPChannelError" })
      yield* channel.prefetch(7)
      const qos = yield* nextMethod(session, 60, 10)
      expect(qos.channel).toBe(1)
      yield* channel.close
      const replacement = yield* connection.createChannel()
      yield* replacement.prefetch(8)
      yield* replacement.sendToQueue("queue", encode("reused"))
      expect(yield* Queue.take(session.publishes)).toBe(1)
      expect((yield* connection.state).state).toBe("Ready")
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("C-T23/C-T26/C-T61 closed connection rejects channel work without spurious Failed changes", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const states = yield* Queue.unbounded<AMQPConnection.ConnectionState>()
      yield* connection.changes.pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* connection.close
      expectFailure(yield* channel.sendToQueue("queue", encode("closed")).pipe(Effect.exit), {
        _tag: "AMQPPublishError",
        outcome: "NotSent"
      })
      expectFailure(yield* channel.prefetch(1).pipe(Effect.exit), { _tag: "AMQPChannelError" })
      yield* channel.close
      expectFailure(yield* channel.cancel("unknown-consumer").pipe(Effect.exit), { _tag: "AMQPChannelError" })
      yield* Effect.yieldNow
      expect((yield* Queue.clear(states)).some((state) => state.state === "Failed")).toBe(false)
      expect((yield* connection.state).state).toBe("Closed")
      expect(yield* Queue.size(session.publishes)).toBe(0)
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("C-S12 established connection retry exhaustion exposes terminal failure", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      let attempts = 0
      const factory = Effect.suspend(() => {
        attempts++
        return attempts === 1 ? broker.factory : Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketCloseError({ code: 1006, closeReason: "Replacement refused" })
          })
        )
      })
      const connection = yield* AMQPConnection.make(factory, { retryConnectionSchedule: Schedule.recurs(2) })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const generation = (yield* connection.state).generation
      yield* session.disconnect
      const failed = yield* waitState(connection, "Failed")
      expect(attempts).toBe(3)
      expect(failed.generation).toBe(generation + 2)
      expect(failed.error).toEqual(expect.objectContaining({ _tag: "AMQPConnectionError" }))
      expectFailure(yield* connection.awaitReady.pipe(Effect.exit), { _tag: "AMQPConnectionError" })
      expectFailure(yield* channel.prefetch(1).pipe(Effect.exit), { _tag: "AMQPConnectionError" })
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH16 second Deliver before content header is a permanent protocol failure", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const deliveries = yield* channel.consume("queue")
      const consuming = yield* deliveries.pipe(Stream.runDrain, Effect.exit, Effect.forkChild)
      const consumer = yield* nextMethod(session, 60, 20)
      // Literal Basic.Deliver: consumer tag "synthetic-consumer", tag 1, empty exchange, routing key "q".
      // Sending it twice without any intervening content header is the malformed sequence under test.
      const deliver = new Uint8Array([
        1,
        0,
        consumer.channel,
        0,
        0,
        0,
        35,
        0,
        60,
        0,
        60,
        18,
        115,
        121,
        110,
        116,
        104,
        101,
        116,
        105,
        99,
        45,
        99,
        111,
        110,
        115,
        117,
        109,
        101,
        114,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        1,
        113,
        206
      ])
      yield* session.send(deliver)
      yield* session.send(deliver)
      const failed = yield* waitState(connection, "Failed")
      expect(failed.error).toEqual(expect.objectContaining({
        _tag: "AMQPConnectionError",
        permanent: true
      }))
      if (failed.error?._tag !== "AMQPConnectionError" || !Cause.isCause(failed.error.cause)) {
        return yield* Effect.fail(new AMQPProtocolError({ reason: "Expected a retained reader failure cause" }))
      }
      expect(Option.getOrThrow(Cause.findErrorOption(failed.error.cause))).toEqual(expect.objectContaining({
        _tag: "AMQPProtocolError",
        reason: "Method interleaved with content frames"
      }))
      expectFailure(yield* Fiber.join(consuming), { _tag: "AMQPConnectionError", permanent: true })
      expect(yield* Queue.size(broker.sessions)).toBe(0)
    }).pipe(Effect.scoped))

  for (
    const scenario of [
      {
        title: "CN06 running channel method on channel zero fails the session",
        // Basic.QosOk (60.11), illegally addressed to connection channel zero.
        bytes: new Uint8Array([1, 0, 0, 0, 0, 0, 4, 0, 60, 0, 11, 206])
      },
      {
        title: "CN07/R-B08 a frame on a never-opened channel fails the session",
        // Basic.QosOk (60.11) on channel seven, which was never allocated.
        bytes: new Uint8Array([1, 0, 7, 0, 0, 0, 4, 0, 60, 0, 11, 206])
      }
    ]
  ) {
    it.effect(scenario.title, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory)
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const pending = yield* channel.checkQueue("pending").pipe(Effect.exit, Effect.forkChild)
        yield* nextMethod(session, 50, 10)
        yield* session.send(scenario.bytes)
        const failed = yield* waitState(connection, "Failed")
        expect(failed.error).toEqual(expect.objectContaining({
          _tag: "AMQPConnectionError",
          permanent: true,
          reason: "AMQP reader failed"
        }))
        expectFailure(yield* connection.awaitReady.pipe(Effect.exit), { _tag: "AMQPConnectionError", permanent: true })
        expectFailure(yield* Fiber.join(pending), { _tag: "AMQPConnectionError", permanent: true })
        expect(yield* Queue.size(broker.sessions)).toBe(0)
      }).pipe(Effect.scoped))
  }

  it.effect("CN08 unsolicited transport loss exposes a Reconnecting diagnostic and advances generation", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        retryConnectionSchedule: Schedule.spaced("1 second")
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const generation = (yield* connection.state).generation
      yield* session.disconnect
      const reconnecting = yield* waitState(connection, "Reconnecting")
      expect(reconnecting.generation).toBe(generation)
      expect(reconnecting.error).toEqual(expect.objectContaining({ _tag: "AMQPConnectionError" }))
      if (reconnecting.error?._tag !== "AMQPConnectionError" || !Cause.isCause(reconnecting.error.cause)) {
        return yield* Effect.fail(new AMQPProtocolError({ reason: "Expected a retained transport failure cause" }))
      }
      expect(Option.getOrThrow(Cause.findErrorOption(reconnecting.error.cause))).toEqual(expect.objectContaining({
        _tag: "SocketError",
        reason: expect.objectContaining({ _tag: "SocketCloseError", closeReason: "Synthetic connection loss" })
      }))
      yield* TestClock.adjust("1 second")
      yield* connection.awaitReady
      const replacement = yield* Queue.take(broker.sessions)
      yield* channel.prefetch(2)
      yield* nextMethod(replacement, 60, 10)
      expect((yield* connection.state).generation).toBe(generation + 1)
    }).pipe(Effect.scoped))

  for (const replyCode of [541, 320]) {
    it.effect(`${replyCode === 541 ? "CN13" : "CN14/R-B07"} server ${replyCode} close is acknowledged and replacement remains usable`, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory, {
          retryConnectionSchedule: Schedule.spaced("1 second")
        })
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const generation = (yield* connection.state).generation
        yield* session.reply(0, 10, 50, { replyCode, replyText: "Scenario broker shutdown", classId: 60, methodId: 40 })
        expect((yield* nextMethod(session, 10, 51)).channel).toBe(0)
        const reconnecting = yield* waitState(connection, "Reconnecting")
        expect(reconnecting.error).toEqual(expect.objectContaining({
          replyCode,
          reason: "Scenario broker shutdown",
          classId: 60,
          methodId: 40,
          permanent: false
        }))
        yield* TestClock.adjust("1 second")
        yield* connection.awaitReady
        const replacement = yield* Queue.take(broker.sessions)
        yield* channel.prefetch(3)
        yield* nextMethod(replacement, 60, 10)
        yield* channel.sendToQueue("queue", encode("replacement"))
        yield* Queue.take(replacement.publishes)
        expect((yield* connection.state).generation).toBe(generation + 1)
      }).pipe(Effect.scoped))
  }

  it.effect("CN37 omitted heartbeat offer adopts server Tune and drives idle heartbeat and watchdog", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ heartbeat: 2 })
      const connection = yield* AMQPConnection.make(broker.factory, { retryConnectionSchedule: Schedule.recurs(1) })
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
      expect((yield* connection.state).generation).toBe(generation + 1)
    }).pipe(Effect.scoped))

  for (const replyCode of [504, 404]) {
    const title = replyCode === 504
      ? "CH04 broker channel 504 preserves exact RPC metadata and recovers the logical channel"
      : "C-S74 passive NOT_FOUND recovers without connection failure changes"
    it.effect(title, () =>
      Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory)
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const generation = (yield* connection.state).generation
        const states = yield* Queue.unbounded<AMQPConnection.ConnectionState>()
        yield* connection.changes.pipe(
          Stream.runForEach((state) => Queue.offer(states, state)),
          Effect.forkChild({ startImmediately: true })
        )
        const reason = replyCode === 504 ? "CHANNEL_ERROR scenario" : "NOT_FOUND scenario"
        const pending = yield* channel.checkQueue("missing").pipe(Effect.exit, Effect.forkChild)
        const request = yield* nextMethod(session, 50, 10)
        yield* session.reply(request.channel, 20, 40, {
          replyCode,
          replyText: reason,
          classId: 50,
          methodId: 10
        })
        expectFailure(yield* Fiber.join(pending), {
          _tag: "AMQPChannelError",
          replyCode,
          reason,
          classId: 50,
          methodId: 10
        })
        yield* nextMethod(session, 20, 41)
        yield* nextMethod(session, 20, 10)
        yield* channel.prefetch(1)
        expect((yield* connection.state).state).toBe("Ready")
        expect((yield* connection.state).generation).toBe(generation)
        yield* Effect.yieldNow
        expect((yield* Queue.clear(states)).some((state) =>
          state.state === "Failed" || state.error?._tag === "AMQPConnectionError"
        )).toBe(false)
        expect(yield* Queue.size(broker.sessions)).toBe(0)
      }).pipe(Effect.scoped))
  }

  it.effect("CH09 active and queued recover RPCs settle across broker channel close and restore usability", () =>
    Effect.gen(function*() {
      let step = "acquiring connection"
      const completed = yield* Deferred.make<void>()
      const scenario = yield* Effect.gen(function*() {
        const broker = yield* makeBroker()
        const connection = yield* AMQPConnection.make(broker.factory, { shutdownTimeout: "1 second" })
        step = "opening channel"
        const session = yield* Queue.take(broker.sessions)
        const channel = yield* connection.createChannel()
        const generation = (yield* connection.state).generation
        const active = yield* channel.recover().pipe(Effect.exit, Effect.forkChild)
        const first = yield* nextMethod(session, 60, 110)
        step = "queueing second recover"
        expect(first.fields).toEqual({ requeue: true })
        const queuedDone = yield* Deferred.make<void>()
        const queued = yield* channel.recover().pipe(
          Effect.onExit(() => Deferred.succeed(queuedDone, undefined)),
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        expect(yield* Queue.size(session.methods)).toBe(0)
        expect(yield* Deferred.isDone(queuedDone)).toBe(false)
        // Exact pinned CH09 initiating method and close fields; native logical channels recover.
        yield* session.reply(first.channel, 20, 40, {
          replyCode: 504,
          replyText: "Nuh-uh!",
          classId: 0,
          methodId: 0
        })
        step = "joining active recover"
        expectFailure(yield* Fiber.join(active), {
          _tag: "AMQPChannelError",
          replyCode: 504,
          reason: "Nuh-uh!",
          classId: 0,
          methodId: 0
        })
        step = "waiting for ChannelCloseOk"
        expect((yield* nextMethod(session, 20, 41)).channel).toBe(first.channel)
        step = "waiting for ChannelOpen"
        const reopened = yield* nextMethod(session, 20, 10)
        step = "waiting for restored Recover"
        const second = yield* nextMethod(session, 60, 110)
        expect(second.channel).toBe(reopened.channel)
        expect(second.fields).toEqual({ requeue: true })
        expect(yield* Deferred.isDone(queuedDone)).toBe(false)
        yield* session.reply(second.channel, 60, 111)
        step = "joining queued recover"
        expect((yield* Fiber.join(queued))._tag).toBe("Success")
        expect(yield* Deferred.isDone(queuedDone)).toBe(true)
        yield* channel.prefetch(3)
        step = "checking restored QoS"
        const qos = yield* nextMethod(session, 60, 10)
        expect(qos.channel).toBe(reopened.channel)
        expect(qos.fields.prefetchCount).toBe(3)
        expect((yield* connection.state).state).toBe("Ready")
        expect((yield* connection.state).generation).toBe(generation)
        expect(yield* Queue.size(broker.sessions)).toBe(0)
      }).pipe(
        Effect.scoped,
        Effect.timeout("2 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.die(new Error(`CH09 deadline expired while ${step}`))),
        Effect.onExit(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild
      )
      // Advance incrementally so transport fibers can run; reserve another second for bounded scope cleanup.
      for (let tick = 0; tick < 3000 && !(yield* Deferred.isDone(completed)); tick++) {
        yield* TestClock.adjust("1 millis")
      }
      expect(yield* Deferred.isDone(completed)).toBe(true)
      yield* Fiber.join(scenario)
    }))

  it.effect("connection-close complement broker 403 fails active and queued passive RPCs without hung callers", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const active = yield* channel.checkQueue("active").pipe(Effect.exit, Effect.forkChild)
      const request = yield* nextMethod(session, 50, 10)
      const admitted = yield* Deferred.make<void>()
      const queued = yield* Deferred.succeed(admitted, undefined).pipe(
        Effect.andThen(channel.checkQueue("queued")),
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(admitted)
      yield* Effect.yieldNow
      yield* session.reply(0, 10, 50, { replyCode: 403, replyText: "Access refused", classId: 50, methodId: 10 })
      for (const fiber of [active, queued]) {
        expectFailure(yield* Fiber.join(fiber), { _tag: "AMQPConnectionError", replyCode: 403 })
      }
      yield* nextMethod(session, 10, 51)
      yield* waitState(connection, "Failed")
      expect(
        (yield* Queue.clear(session.methods)).some((method) =>
          method.channel === request.channel && method.classId === 50 && method.methodId === 10
        )
      ).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("CA34/CA35 explicit channel close settles all confirms Unknown and releases capacity", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        maxPendingOperations: 2,
        shutdownTimeout: "1 second",
        retryConnectionSchedule: Schedule.recurs(1)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 2 })
      const pending = []
      for (const body of ["first", "second"]) {
        pending.push(yield* channel.sendToQueue("queue", encode(body)).pipe(Effect.exit, Effect.forkChild))
        yield* Queue.take(session.publishes)
      }
      // Native close drains admitted confirmations until the shutdown deadline, then retires them Unknown.
      const closing = yield* channel.close.pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(closing)
      for (const fiber of pending) {
        expectFailure(yield* Fiber.join(fiber), { _tag: "AMQPPublishError", outcome: "Unknown" })
      }
      for (let index = 0; index < 3; index++) {
        expectFailure(yield* channel.sendToQueue("queue", encode("closed")).pipe(Effect.exit), {
          _tag: "AMQPPublishError",
          outcome: "NotSent"
        })
      }
      yield* connection.awaitReady
      const replacementSession = yield* Queue.take(broker.sessions)
      const replacement = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 2 })
      const fresh = []
      let channelId = 0
      for (const body of ["fresh-one", "fresh-two"]) {
        fresh.push(yield* replacement.sendToQueue("queue", encode(body)).pipe(Effect.forkChild))
        channelId = yield* Queue.take(replacementSession.publishes)
      }
      yield* replacementSession.reply(channelId, 60, 80, { deliveryTag: 2n, multiple: true })
      for (const fiber of fresh) yield* Fiber.join(fiber)
      expect(yield* Queue.size(replacementSession.publishes)).toBe(0)
      expect(yield* Queue.size(session.publishes)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("CH26 out-of-order ack leaves the unacknowledged tail precisely pending", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory)
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true })
      const pending = []
      const tailCompleted = yield* Deferred.make<void>()
      for (const body of ["one", "two", "three", "tail"]) {
        pending.push(
          yield* channel.sendToQueue("queue", encode(body)).pipe(
            Effect.onExit(() => body === "tail" ? Deferred.succeed(tailCompleted, undefined) : Effect.void),
            Effect.exit,
            Effect.forkChild
          )
        )
        yield* Queue.take(session.publishes)
      }
      const opened = yield* nextMethod(session, 20, 10)
      yield* session.reply(opened.channel, 60, 80, { deliveryTag: 3n, multiple: false })
      expect((yield* Fiber.join(pending[2]))._tag).toBe("Success")
      yield* session.reply(opened.channel, 60, 80, { deliveryTag: 2n, multiple: true })
      for (const fiber of pending.slice(0, 2)) expect((yield* Fiber.join(fiber))._tag).toBe("Success")
      // A completed Qos round trip proves the reader has processed both confirmations.
      yield* channel.prefetch(1)
      expect(yield* Deferred.isDone(tailCompleted)).toBe(false)
      yield* session.reply(opened.channel, 60, 80, { deliveryTag: 4n, multiple: false })
      expect((yield* Fiber.join(pending[3]))._tag).toBe("Success")
    }).pipe(Effect.scoped))
})
