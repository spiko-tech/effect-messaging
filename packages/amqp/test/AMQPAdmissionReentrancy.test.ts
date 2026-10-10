import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Option, Queue, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import type * as AMQPError from "../src/AMQPError.ts"
import * as Codec from "../src/internal/codec.ts"
import { encode } from "./dependencies.ts"

const makeImmediateBroker = Effect.fnUntraced(function*(
  response: (frame: Codec.Frame) => Effect.Effect<Array<Uint8Array>, AMQPError.AMQPProtocolError>
) {
  const methods = yield* Queue.unbounded<Codec.Method & { readonly channel: number }>()
  const factory = Effect.gen(function*() {
    const decoder = yield* Codec.makeFrameDecoder()
    const start = yield* Codec.encodeMethod(0, 10, 10, {
      versionMajor: 0,
      versionMinor: 9,
      serverProperties: { product: "Immediate callback peer" },
      mechanisms: "PLAIN",
      locales: "en_US"
    })
    const tune = yield* Codec.encodeMethod(0, 10, 30, { channelMax: 32, frameMax: 131072, heartbeat: 0 })
    const openOk = yield* Codec.encodeMethod(0, 10, 41)
    const closeOk = yield* Codec.encodeMethod(0, 10, 51)
    const incoming: Array<Uint8Array> = []
    let pendingRead: ((effect: Effect.Effect<readonly [Uint8Array]>) => void) | undefined
    let protocolBytes = 0
    let pending: { readonly done: Deferred.Deferred<void>; received: boolean } | undefined
    const emit = (bytes: Uint8Array) => {
      const resume = pendingRead
      if (resume === undefined) {
        incoming.push(bytes)
        return
      }
      pendingRead = undefined
      if (pending !== undefined) pending.received = true
      // Unlike Queue.offer, invoke the transport read continuation directly in the write call stack.
      resume(Effect.succeed([bytes]))
    }
    const reply = Effect.fnUntraced(function*(channel: number, classId: number, methodId: number, fields = {}) {
      emit(yield* Codec.encodeMethod(channel, classId, methodId, fields))
    })
    const write = Effect.fnUntraced(function*(chunk: Uint8Array | string | Socket.CloseEvent) {
      if (Socket.isCloseEvent(chunk)) return
      let bytes = typeof chunk === "string" ? encode(chunk) : chunk
      if (protocolBytes < Codec.PROTOCOL_HEADER.length) {
        const count = Math.min(bytes.length, Codec.PROTOCOL_HEADER.length - protocolBytes)
        protocolBytes += count
        bytes = bytes.subarray(count)
        if (protocolBytes === Codec.PROTOCOL_HEADER.length) {
          emit(start)
        }
      }
      let done: Deferred.Deferred<void> | undefined
      yield* decoder.feed(
        bytes,
        Effect.fnUntraced(function*(frame) {
          if (frame.type === 1) {
            const method = yield* Codec.decodeMethod(frame.payload)
            Queue.offerUnsafe(methods, { ...method, channel: frame.channel })
            switch (`${method.classId}:${method.methodId}`) {
              case "10:11":
                emit(tune)
                break
              case "10:40":
                emit(openOk)
                break
              case "10:50":
                emit(closeOk)
                break
              case "20:10":
                yield* reply(frame.channel, 20, 11)
                break
              case "20:40":
                yield* reply(frame.channel, 20, 41)
                break
              case "85:10":
                yield* reply(frame.channel, 85, 11)
                break
              case "60:10":
                yield* reply(frame.channel, 60, 11)
                break
              case "60:20":
                yield* reply(frame.channel, 60, 21, { consumerTag: "synthetic-consumer" })
                break
              case "60:30":
                yield* reply(frame.channel, 60, 31, { consumerTag: method.fields.consumerTag })
                break
            }
          }
          const replies = yield* response(frame)
          if (replies.length === 0) return true
          done = Deferred.makeUnsafe<void>()
          pending = { done, received: false }
          const batch = new Uint8Array(replies.reduce((total, item) => total + item.length, 0))
          let offset = 0
          for (const item of replies) {
            batch.set(item, offset)
            offset += item.length
          }
          emit(batch)
          return true
        })
      )
      const completion = done
      if (completion !== undefined) {
        yield* Deferred.await(completion)
        pending = undefined
      }
    }, Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })))
    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Effect.gen(function*() {
            // A subsequent pull means the AMQP reader has dispatched the entire preceding batch.
            if (pending?.received) yield* Deferred.succeed(pending.done, undefined)
            return yield* Effect.callback<readonly [Uint8Array]>((resume) => {
              const bytes = incoming.shift()
              if (bytes !== undefined) {
                if (pending !== undefined) pending.received = true
                resume(Effect.succeed([bytes]))
              } else {
                pendingRead = resume
              }
              return Effect.sync(() => {
                if (pendingRead === resume) pendingRead = undefined
              })
            })
          }),
          upgrade: () => Effect.void
        }),
        () =>
          Effect.sync(() => {
            pendingRead = undefined
            incoming.length = 0
          })
      ),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
      })
    })
  }).pipe(Effect.mapError((cause) =>
    new Socket.SocketError({
      reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
    })
  ))
  const nextMethod = Effect.fnUntraced(function*(classId: number, methodId: number) {
    while (true) {
      const method = yield* Queue.take(methods)
      if (method.classId === classId && method.methodId === methodId) return method
    }
  })
  return { factory, nextMethod }
})

describe("AMQP admission with immediate broker responses", () => {
  it.effect("accepts the first publisher confirmation before the body write returns", () =>
    Effect.gen(function*() {
      const broker = yield* makeImmediateBroker(Effect.fnUntraced(function*(frame) {
        return frame.type === 3
          ? [yield* Codec.encodeMethod(frame.channel, 60, 80, { deliveryTag: 1n, multiple: false })]
          : []
      }))
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel({ confirm: true })
      // Let the channel-open write finish and the transport writer return to its idle wait first.
      yield* Effect.yieldNow
      const published = yield* channel.sendToQueue("queue", encode("first")).pipe(Effect.exit)
      expect(published._tag, published._tag === "Failure" ? Cause.pretty(published.cause) : undefined).toBe("Success")
      yield* channel.prefetch(1)
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("preserves a queued redelivery received before the recover write returns", () =>
    Effect.gen(function*() {
      const broker = yield* makeImmediateBroker(Effect.fnUntraced(function*(frame) {
        if (frame.type !== 1) return []
        const method = yield* Codec.decodeMethod(frame.payload)
        if (method.classId !== 60 || method.methodId !== 110) return []
        return [
          yield* Codec.encodeMethod(frame.channel, 60, 111),
          yield* Codec.encodeMethod(frame.channel, 60, 60, {
            consumerTag: "synthetic-consumer",
            deliveryTag: 2n,
            redelivered: true,
            exchange: "",
            routingKey: "queue"
          }),
          yield* Codec.encodeContentHeader(frame.channel, 11n, {}),
          yield* Codec.encodeFrame(3, frame.channel, encode("redelivered"))
        ]
      }))
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const deliveries = yield* channel.consume("queue")
      const consumer = yield* broker.nextMethod(60, 20)
      yield* Effect.yieldNow
      yield* channel.recover()
      // Do not drain the consumer until RecoverOk and the whole redelivery have been dispatched.
      const message = Option.getOrThrow(yield* Stream.runHead(deliveries))
      expect(new TextDecoder().decode(message.content)).toBe("redelivered")
      expect(message.fields.deliveryTag).toBe(2n)
      expect(message.fields.redelivered).toBe(true)
      expect((yield* channel.ack(message).pipe(Effect.exit))._tag).toBe("Success")
      const ack = yield* broker.nextMethod(60, 80)
      expect(ack.channel).toBe(consumer.channel)
      expect(ack.fields).toEqual({ deliveryTag: 2n, multiple: false })
      expect((yield* connection.state).state).toBe("Ready")
    }).pipe(Effect.scoped))

  it.effect("nackAll does not settle a new delivery received during its transport write", () =>
    Effect.gen(function*() {
      const broker = yield* makeImmediateBroker(Effect.fnUntraced(function*(frame) {
        if (frame.type !== 1) return []
        const method = yield* Codec.decodeMethod(frame.payload)
        const first = method.classId === 60 && method.methodId === 20
        const requeue = method.classId === 60 && method.methodId === 120
        if (!first && !requeue) return []
        return [
          yield* Codec.encodeMethod(frame.channel, 60, 60, {
            consumerTag: "synthetic-consumer",
            deliveryTag: first ? 1n : 2n,
            redelivered: requeue,
            exchange: "",
            routingKey: "queue"
          }),
          yield* Codec.encodeContentHeader(frame.channel, 7n, {}),
          yield* Codec.encodeFrame(3, frame.channel, encode("payload"))
        ]
      }))
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const stream = yield* channel.consume("queue")
      const messages = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
      yield* stream.pipe(Stream.runForEach((message) => Queue.offer(messages, message)), Effect.forkChild)
      expect((yield* Queue.take(messages)).fields.deliveryTag).toBe(1n)
      yield* Effect.yieldNow
      yield* channel.nackAll(true)
      const redelivered = yield* Queue.take(messages)
      expect(redelivered.fields.deliveryTag).toBe(2n)
      expect(redelivered.fields.redelivered).toBe(true)
      const settled = yield* channel.ack(redelivered).pipe(Effect.exit)
      expect(settled._tag, settled._tag === "Failure" ? Cause.pretty(settled.cause) : undefined).toBe("Success")
    }).pipe(Effect.scoped))
})
