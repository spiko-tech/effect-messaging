import { Deferred, Effect, Latch, Queue } from "effect"
import * as Socket from "effect/socket/Socket"
import type * as AMQPError from "../src/AMQPError.ts"
import type * as AMQPTypes from "../src/AMQPTypes.ts"
import * as Codec from "../src/internal/codec.ts"

export const makeBroker = Effect.fnUntraced(function*(options: {
  readonly heartbeat?: number
  readonly automaticTopology?: boolean
  readonly frameMax?: number
  readonly channelMax?: number
} = {}) {
  const sessions = yield* Queue.unbounded<Session>()
  const factory = Effect.gen(function*() {
    const incoming = yield* Queue.unbounded<Uint8Array>()
    const methods = yield* Queue.unbounded<Codec.Method & { readonly channel: number }>()
    const publishes = yield* Queue.unbounded<number>()
    const frames = yield* Queue.unbounded<Codec.Frame>()
    const stalledWrites = yield* Queue.unbounded<Uint8Array | string>()
    const writeGate = yield* Latch.make(true)
    const closed = yield* Deferred.make<never, Socket.SocketError>()
    const decoder = yield* Codec.makeFrameDecoder().pipe(
      Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }))
    )
    let protocolBytes = 0
    const disconnect = Deferred.fail(
      closed,
      new Socket.SocketError({
        reason: new Socket.SocketCloseError({ code: 1006, closeReason: "Synthetic connection loss" })
      })
    ).pipe(Effect.asVoid)
    const reply = Effect.fnUntraced(function*(
      channel: number,
      classId: number,
      methodId: number,
      fields: Record<string, AMQPTypes.FieldValue> = {}
    ) {
      const bytes = yield* Codec.encodeMethod(channel, classId, methodId, fields)
      yield* Queue.offer(incoming, bytes)
    })
    const write = Effect.fnUntraced(function*(chunk: Uint8Array | string | Socket.CloseEvent) {
      if (Socket.isCloseEvent(chunk)) return yield* disconnect
      if (!writeGate.isOpen()) yield* Queue.offer(stalledWrites, chunk)
      yield* writeGate.await
      let bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
      if (protocolBytes < Codec.PROTOCOL_HEADER.length) {
        const count = Math.min(bytes.length, Codec.PROTOCOL_HEADER.length - protocolBytes)
        protocolBytes += count
        bytes = bytes.subarray(count)
        if (protocolBytes === Codec.PROTOCOL_HEADER.length) {
          yield* reply(0, 10, 10, {
            versionMajor: 0,
            versionMinor: 9,
            serverProperties: { product: "Synthetic" },
            mechanisms: "PLAIN",
            locales: "en_US"
          })
        }
      }
      yield* decoder.feed(
        bytes,
        Effect.fnUntraced(function*(frame: Codec.Frame) {
          yield* Queue.offer(frames, frame)
          if (frame.type === 3) {
            yield* Queue.offer(publishes, frame.channel)
            return true
          }
          if (frame.type !== 1) return true
          const method = yield* Codec.decodeMethod(frame.payload)
          yield* Queue.offer(methods, { ...method, channel: frame.channel })
          const key = `${method.classId}:${method.methodId}`
          switch (key) {
            case "10:11":
              yield* reply(0, 10, 30, {
                channelMax: options.channelMax ?? 32,
                frameMax: options.frameMax ?? 131072,
                heartbeat: options.heartbeat ?? 0
              })
              break
            case "10:40":
              yield* reply(0, 10, 41)
              break
            case "10:50":
              yield* reply(0, 10, 51)
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
            case "40:10":
              if (options.automaticTopology) yield* reply(frame.channel, 40, 11)
              break
            case "50:10":
              if (options.automaticTopology) {
                yield* reply(frame.channel, 50, 11, {
                  queue: method.fields.queue || "synthetic-queue",
                  messageCount: 0,
                  consumerCount: 0
                })
              }
              break
            case "50:20":
              if (options.automaticTopology) yield* reply(frame.channel, 50, 21)
              break
          }
          return true
        })
      )
    }, Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })))
    const socket = Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Effect.raceFirst(
            Queue.take(incoming).pipe(Effect.map((bytes): readonly [Uint8Array] => [bytes])),
            Deferred.await(closed)
          ),
          upgrade: () => Effect.void
        }),
        () => disconnect
      ),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
      })
    })
    const send = (bytes: Uint8Array) => Queue.offer(incoming, bytes).pipe(Effect.asVoid)
    yield* Queue.offer(sessions, {
      methods,
      publishes,
      frames,
      stalledWrites,
      reply,
      disconnect,
      send,
      pauseWrites: writeGate.close.pipe(Effect.asVoid),
      resumeWrites: writeGate.open.pipe(Effect.asVoid)
    })
    return socket
  })
  return { factory, sessions }
})

export interface Session {
  readonly frames: Queue.Queue<Codec.Frame>
  readonly methods: Queue.Queue<Codec.Method & { readonly channel: number }>
  readonly publishes: Queue.Queue<number>
  readonly stalledWrites: Queue.Queue<Uint8Array | string>
  readonly pauseWrites: Effect.Effect<void>
  readonly resumeWrites: Effect.Effect<void>
  readonly reply: (
    channel: number,
    classId: number,
    methodId: number,
    fields?: Record<string, AMQPTypes.FieldValue>
  ) => Effect.Effect<void, AMQPError.AMQPProtocolError>
  readonly disconnect: Effect.Effect<void>
  readonly send: (bytes: Uint8Array) => Effect.Effect<void>
}

export const nextMethod = Effect.fnUntraced(function*(session: Session, classId: number, methodId: number) {
  while (true) {
    const method = yield* Queue.take(session.methods)
    if (method.classId === classId && method.methodId === methodId) return method
  }
})
