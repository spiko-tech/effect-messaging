import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Result, Schedule, Schema } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { broker, encode } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

describe("transactions", () => {
  for (const action of ["Select", "Commit", "Rollback"] as const) {
    for (const completion of ["failure", "deadline"] as const) {
      it.effect(`accepts authoritative ${action.toLowerCase()}-ok before a delayed write ${completion}`, () =>
        Effect.scoped(Effect.gen(function*() {
          const broker = yield* makeBroker()
          const release = Deferred.makeUnsafe<void, Socket.SocketError>()
          const stalled = Deferred.makeUnsafe<void>()
          const methodId = action === "Select" ? 10 : action === "Commit" ? 20 : 30
          const factory = broker.factory.pipe(Effect.map((socket) =>
            Socket.make({
              reader: socket.reader,
              writer: socket.writer.pipe(Effect.map((writer) => {
                const write = Effect.fnUntraced(
                  function*(chunk: Uint8Array | string | Socket.CloseEvent) {
                    let delay = false
                    if (chunk instanceof Uint8Array && chunk[0] === 1) {
                      const frame = yield* Schema.decodeUnknownEffect(Codec.FrameCodec)(chunk)
                      const method = yield* Codec.decodeMethod(frame.payload)
                      delay = method.classId === 90 && method.methodId === methodId
                    }
                    yield* writer.write(chunk)
                    if (delay) {
                      Deferred.doneUnsafe(stalled, Effect.void)
                      yield* Deferred.await(release)
                    }
                  },
                  Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }))
                )
                return { write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }
              }))
            })
          ))
          const connection = yield* AMQPConnection.make(factory, {
            heartbeat: 0,
            connectionTimeout: "100 millis",
            retryConnectionSchedule: Schedule.recurs(0)
          })
          const session = yield* Queue.take(broker.sessions)
          const channel = yield* connection.createChannel()
          yield* Effect.gen(function*() {
            let receipt: AMQPConsumeMessage.AMQPConsumeMessage | undefined
            if (action !== "Select") {
              const selecting = yield* channel.txSelect().pipe(Effect.forkScoped)
              const request = yield* nextMethod(session, 90, 10)
              yield* session.reply(request.channel, 90, 11)
              yield* Fiber.join(selecting)
              const getting = yield* channel.get("queue").pipe(Effect.forkScoped)
              const get = yield* nextMethod(session, 60, 70)
              yield* session.reply(get.channel, 60, 71, {
                deliveryTag: BigInt(1),
                redelivered: false,
                exchange: "",
                routingKey: "queue",
                messageCount: 0
              })
              yield* session.send(yield* Codec.encodeContentHeader(get.channel, BigInt(0), {}))
              receipt = Option.getOrThrow(yield* Fiber.join(getting))
              yield* channel.ack(receipt)
            }
            const changing = yield* (action === "Select" ?
              channel.txSelect() :
              action === "Commit"
              ? channel.txCommit()
              : channel.txRollback()).pipe(Effect.result, Effect.forkScoped)
            const request = yield* nextMethod(session, 90, methodId)
            yield* Deferred.await(stalled)
            yield* session.reply(request.channel, 90, methodId + 1)
            if (completion === "deadline") {
              yield* TestClock.adjust("200 millis")
            } else {
              yield* TestClock.adjust("0 millis")
              yield* Deferred.fail(
                release,
                new Socket.SocketError({
                  reason: new Socket.SocketWriteError({ cause: new Error("Late transport failure") })
                })
              )
              yield* TestClock.adjust("0 millis")
            }
            expect(Result.isSuccess(yield* Fiber.join(changing))).toBe(true)
            if (completion === "deadline" && receipt !== undefined) {
              yield* Deferred.succeed(release, undefined)
              const settlement = yield* Effect.result(channel.ack(receipt))
              if (action === "Rollback") {
                expect(Result.isSuccess(settlement)).toBe(true)
              } else {
                expect(Result.isFailure(settlement)).toBe(true)
                if (Result.isFailure(settlement) && settlement.failure._tag === "AMQPSettlementError") {
                  expect(settlement.failure.kind).toBe("AlreadySettled")
                }
                const rollback = yield* channel.txRollback().pipe(Effect.forkScoped)
                const request = yield* nextMethod(session, 90, 30)
                yield* session.reply(request.channel, 90, 31)
                yield* Fiber.join(rollback)
                expect(Result.isFailure(yield* Effect.result(channel.ack(receipt)))).toBe(true)
              }
            }
            if (completion === "failure") {
              const retired = yield* Effect.result(connection.awaitReady)
              expect(Result.isFailure(retired)).toBe(true)
            }
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        })))
    }
  }

  it.live("recover preserves staged ack, nack and reject receipts while redelivering only unstaged receipts", () =>
    Effect.scoped(Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(broker)
      const publisher = yield* connection.createChannel({ confirm: true })
      const channel = yield* connection.createChannel()
      const queue = yield* publisher.assertQueue("", { exclusive: true, durable: false, autoDelete: true })
      for (const body of ["acked", "nacked", "rejected", "unstaged"]) {
        yield* publisher.sendToQueue(queue, encode(body))
      }
      yield* channel.txSelect()
      const acknowledged = Option.getOrThrow(yield* channel.get(queue))
      const nacked = Option.getOrThrow(yield* channel.get(queue))
      const rejected = Option.getOrThrow(yield* channel.get(queue))
      const unstaged = Option.getOrThrow(yield* channel.get(queue))
      yield* channel.ack(acknowledged)
      yield* channel.nack(nacked, false, false)
      yield* channel.reject(rejected, true)
      yield* channel.recover()
      const redelivery = Option.getOrThrow(yield* channel.get(queue))
      expect(redelivery.content).toEqual(encode("unstaged"))
      expect(redelivery.fields.redelivered).toBe(true)
      expect(Option.isNone(yield* channel.get(queue))).toBe(true)
      yield* channel.txRollback()
      const stale = yield* Effect.result(channel.ack(unstaged))
      expect(Result.isFailure(stale)).toBe(true)
      if (Result.isFailure(stale) && stale.failure._tag === "AMQPSettlementError") {
        expect(stale.failure.kind).toBe("Stale")
      }
      for (const receipt of [acknowledged, nacked, rejected, redelivery]) yield* channel.ack(receipt)
      yield* channel.txCommit()
      expect(Option.isNone(yield* publisher.get(queue))).toBe(true)
    })).pipe(Effect.timeout("10 seconds")))

  it.effect("never accepts rollback-ok as a commit reply", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const select = yield* channel.txSelect().pipe(Effect.forkScoped)
      const selecting = yield* nextMethod(session, 90, 10)
      yield* session.reply(selecting.channel, 90, 11)
      yield* Fiber.join(select)
      const commit = yield* channel.txCommit().pipe(Effect.result, Effect.forkScoped)
      const committing = yield* nextMethod(session, 90, 20)
      yield* session.reply(committing.channel, 90, 31)
      const result = yield* Fiber.join(commit)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("AMQPTransactionError")
        if (result.failure._tag === "AMQPTransactionError") expect(result.failure.outcome).toBe("Unknown")
      }
    })))

  it.effect("rejects confirmation/transaction mode conflicts before wire admission", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const channel = yield* connection.createChannel({ confirm: true })
      const result = yield* Effect.result(channel.txSelect())
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("AMQPChannelError")
    })))

  it.effect("reports a lost commit reply as Unknown without replaying it", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        retryConnectionSchedule: Schedule.recurs(3)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const select = yield* channel.txSelect().pipe(Effect.forkScoped)
      const selecting = yield* nextMethod(session, 90, 10)
      yield* session.reply(selecting.channel, 90, 11)
      yield* Fiber.join(select)
      const commit = yield* channel.txCommit().pipe(Effect.result, Effect.forkScoped)
      yield* nextMethod(session, 90, 20)
      yield* session.disconnect
      const result = yield* Fiber.join(commit)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) && result.failure._tag === "AMQPTransactionError") {
        expect(result.failure.outcome).toBe("Unknown")
      }
      // Recovery only reselects mode. Reply to that request so finalization remains bounded.
      const replacement = yield* Queue.take(broker.sessions)
      const reselect = yield* nextMethod(replacement, 90, 10)
      yield* replacement.reply(reselect.channel, 90, 11)
      yield* connection.awaitReady
    })))

  it.live("publishes only on commit and discards publications on rollback", () =>
    Effect.scoped(Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(broker)
      const transaction = yield* connection.createChannel()
      const observer = yield* connection.createChannel()
      const queue = yield* observer.assertQueue("", { exclusive: true, durable: false, autoDelete: true })
      yield* transaction.txSelect()
      yield* transaction.sendToQueue(queue, encode("committed"), { headers: {} })
      expect(Option.isNone(yield* observer.get(queue))).toBe(true)
      yield* transaction.txCommit()
      const committed = Option.getOrThrow(yield* observer.get(queue))
      expect(committed.content).toEqual(encode("committed"))
      yield* observer.ack(committed)
      yield* transaction.sendToQueue(queue, encode("rolled-back"), { headers: {} })
      yield* transaction.txRollback()
      expect(Option.isNone(yield* observer.get(queue))).toBe(true)
    })).pipe(Effect.timeout("10 seconds")))

  it.live("rolls back acknowledgements and settles them only after commit", () =>
    Effect.scoped(Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(broker)
      const channel = yield* connection.createChannel()
      const queue = yield* channel.assertQueue("", { exclusive: true, durable: false, autoDelete: true })
      yield* channel.sendToQueue(queue, encode("acknowledgement"), { headers: {} })
      const message = Option.getOrThrow(yield* channel.get(queue))
      yield* channel.txSelect()
      yield* channel.ack(message)
      yield* channel.txRollback()
      yield* channel.ack(message)
      yield* channel.txCommit()
      expect(Option.isNone(yield* channel.get(queue))).toBe(true)
    })).pipe(Effect.timeout("10 seconds")))
})
