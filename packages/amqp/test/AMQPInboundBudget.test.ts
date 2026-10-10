import { describe, it } from "@effect/vitest"
import { Array as Arr, Deferred, Effect, Fiber, Latch, Queue, Schedule, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { expectFailure } from "./assertions.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

const nodeHeader = (): Uint8Array => {
  // Independent zero-body header with one array containing eight empty field tables.
  const bytes = new Uint8Array(18 + 7 + 8 * 5)
  bytes.set([0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 0])
  const view = new DataView(bytes.buffer)
  view.setUint32(14, bytes.length - 18)
  bytes.set([1, 110, 65], 18)
  view.setUint32(21, 8 * 5)
  for (let i = 0; i < 8; i++) bytes[25 + i * 5] = 70
  return bytes
}

describe("AMQP inbound resource budgets", () => {
  it.effect("rejects an oversized frame from its header before receiving or allocating the body", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        frameMax: 8192,
        maxBufferedBytes: 2 * 1024 * 1024,
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      // Advertises a 1MiB payload, but sends no payload or end marker.
      yield* session.send(new Uint8Array([3, 0, 1, 0, 16, 0, 0]))
      const operation = yield* channel.prefetch(1).pipe(
        Effect.timeout("1 second"),
        Effect.exit,
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(operation), { _tag: "AMQPConnectionError", permanent: true })
    }).pipe(Effect.scoped))

  it.effect("applies the broker's frame limit before parsing the frame coalesced with tune", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 8192 })
      const injected = yield* Deferred.make<void>()
      const factory = Effect.gen(function*() {
        const socket = yield* broker.factory
        return Socket.make({
          writer: socket.writer,
          reader: Effect.map(socket.reader, (reader) => ({
            ...reader,
            pull: Effect.flatMap(reader.pull, (batch) =>
              Effect.forEach(batch, (chunk) => {
                if (
                  typeof chunk === "string" || chunk[7] !== 0 || chunk[8] !== 10 || chunk[9] !== 0 || chunk[10] !== 30
                ) return Effect.succeed(chunk)
                const combined = new Uint8Array(chunk.length + 7)
                combined.set(chunk)
                combined.set([3, 0, 1, 0, 16, 0, 0], chunk.length)
                return Deferred.succeed(injected, undefined).pipe(Effect.as(combined))
              }))
          }))
        })
      })
      const connecting = yield* AMQPConnection.make(factory, {
        frameMax: 0,
        maxBufferedBytes: 2 * 1024 * 1024,
        retryConnectionSchedule: Schedule.recurs(0)
      }).pipe(Effect.timeout("1 second"), Effect.exit, Effect.forkChild)
      yield* Deferred.await(injected)
      yield* TestClock.adjust("1 second")
      expectFailure(yield* Fiber.join(connecting), { _tag: "AMQPConnectionError", permanent: true })
    }).pipe(Effect.scoped))

  it.effect("charges decoded table nodes retained behind a slow consumer against the connection budget", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        frameMax: 8192,
        maxBufferedBytes: 8192,
        retryConnectionSchedule: Schedule.recurs(0)
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const entered = yield* Deferred.make<void>()
      const stream = yield* channel.consume("queue")
      yield* stream.pipe(
        Stream.runForEach(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
        Effect.forkChild
      )
      const registration = yield* nextMethod(session, 60, 20)
      const deliver = (tag: bigint) =>
        session.reply(registration.channel, 60, 60, {
          consumerTag: "synthetic-consumer",
          deliveryTag: tag,
          exchange: "",
          routingKey: "queue"
        }).pipe(Effect.andThen(
          Codec.encodeFrame(2, registration.channel, nodeHeader()).pipe(
            Effect.flatMap(session.send)
          )
        ))
      yield* deliver(1n)
      yield* Deferred.await(entered)
      for (const tag of [2n, 3n, 4n]) yield* deliver(tag)
      const operation = yield* channel.prefetch(1).pipe(Effect.exit)
      expectFailure(operation, { _tag: "AMQPConnectionError", permanent: true })
    }).pipe(Effect.scoped))

  it.effect("enforces tune's frame limit while the preceding StartOk transport write remains stalled", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 8192 })
      const stalled = yield* Deferred.make<void>()
      const gate = yield* Latch.make()
      const factory = Effect.gen(function*() {
        const socket = yield* broker.factory
        return Socket.make({
          writer: Effect.map(socket.writer, (writer) => {
            const write = Effect.fnUntraced(function*(chunk: Uint8Array | string | Socket.CloseEvent) {
              yield* writer.write(chunk)
              if (
                chunk instanceof Uint8Array && chunk[0] === 1 && chunk[7] === 0 && chunk[8] === 10 &&
                chunk[9] === 0 && chunk[10] === 11
              ) {
                yield* Deferred.succeed(stalled, undefined)
                yield* gate.await
              }
            })
            return { ...writer, write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }
          }),
          reader: Effect.map(socket.reader, (reader) => ({
            ...reader,
            pull: Effect.map(reader.pull, (batch) =>
              Arr.map(batch, (chunk) => {
                if (
                  typeof chunk === "string" || chunk[7] !== 0 || chunk[8] !== 10 || chunk[9] !== 0 || chunk[10] !== 30
                ) return chunk
                const combined = new Uint8Array(chunk.length + 7)
                combined.set(chunk)
                combined.set([3, 0, 1, 0, 16, 0, 0], chunk.length)
                return combined
              }))
          }))
        })
      })
      const connecting = yield* AMQPConnection.make(factory, {
        frameMax: 0,
        maxBufferedBytes: 2 * 1024 * 1024,
        retryConnectionSchedule: Schedule.recurs(0)
      }).pipe(Effect.timeout("1 second"), Effect.exit, Effect.forkChild)
      yield* Deferred.await(stalled)
      yield* TestClock.adjust("10 seconds")
      expectFailure(yield* Fiber.join(connecting), { _tag: "AMQPConnectionError", permanent: true })
    }).pipe(Effect.scoped))
})
