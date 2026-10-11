import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Duration, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as TestClock from "effect/testing/TestClock"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSMessage from "../src/NATSMessage.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const harness = Effect.gen(function*() {
  const incoming = yield* Queue.unbounded<Uint8Array>()
  const writes = yield* Queue.unbounded<string>()
  const factory: NATSConnection.SocketFactory = () =>
    Effect.sync(() => {
      Queue.offerUnsafe(
        incoming,
        encoder.encode(
          "INFO " + JSON.stringify({
            server_id: "review",
            server_name: "review",
            version: "2.15.0",
            go: "test",
            host: "review",
            port: 4222,
            proto: 1,
            max_payload: 32 * 1024 * 1024,
            client_id: 1,
            headers: true
          }) + "\r\n"
        )
      )
      const write: Socket.Writer["write"] = (chunk) =>
        Effect.sync(() => {
          if (Socket.isCloseEvent(chunk)) return
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk)
          Queue.offerUnsafe(writes, text)
          if (text === "PING\r\n") Queue.offerUnsafe(incoming, encoder.encode("PONG\r\n"))
        })
      return Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(incoming).pipe(Effect.map((chunk) => [chunk] as const)),
          upgrade: () => Effect.void
        }),
        writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) })
      })
    })
  return { factory, writes, feed: (bytes: Uint8Array) => Queue.offer(incoming, bytes) }
})
const frame = (sid: number, data: Uint8Array, headers?: string) => {
  const headerBytes = headers === undefined ? new Uint8Array() : encoder.encode(headers)
  const size = headerBytes.length + data.length
  const line = encoder.encode(
    headers === undefined ? `MSG q ${sid} ${size}\r\n` : `HMSG q ${sid} ${headerBytes.length} ${size}\r\n`
  )
  const bytes = new Uint8Array(line.length + size + 2)
  bytes.set(line)
  bytes.set(headerBytes, line.length)
  bytes.set(data, line.length + headerBytes.length)
  bytes.set([13, 10], bytes.length - 2)
  return bytes
}
const headers = "NATS/1.0\r\nX: retained\r\n\r\n"
const retainedSize = encoder.encode(headers).length + encoder.encode("q").length

describe("reviewed core lifecycle and byte budget regressions", () => {
  it.effect.each(["timer", "sentinel"] as const)(
    "multi-request %s waits for its deadline after an early scheduler wakeup",
    (strategy) =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(peer.factory)
        const clock = yield* Clock.Clock
        const armed = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        let wokeEarly = false
        const earlyClock: Clock.Clock = {
          ...clock,
          sleep: (duration) => {
            if (wokeEarly || Duration.toMillis(duration) !== 100) return clock.sleep(duration)
            wokeEarly = true
            return Deferred.succeed(armed, undefined).pipe(Effect.andThen(clock.sleep(Duration.millis(99))))
          }
        }
        const replies = yield* connection.requestMany("q", undefined, { strategy, maxWait: 100 }).pipe(
          Effect.provideService(Clock.Clock, earlyClock)
        )
        const collected = yield* Stream.runCollect(replies).pipe(
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(armed)
        yield* TestClock.adjust(99)
        expect(yield* Deferred.isDone(finished)).toBe(false)
        yield* TestClock.adjust(1)
        expect(yield* Fiber.join(collected)).toEqual([])
      }).pipe(Effect.scoped)
  )

  it.live("reconnect without automatic recovery completes with a typed terminal error", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { reconnect: false })
      const failure = yield* connection.reconnect.pipe(Effect.flip, Effect.timeout("1 second"))
      expect(failure._tag).toBe("NATSConnectionError")
      expect(failure.code).toBe("closed")
      expect((yield* connection.state).state).toBe("Closed")
    }).pipe(Effect.scoped))

  it.live("concurrent close terminates reconnect even without a newer session", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory, { reconnectTimeWait: 60_000, reconnectJitter: 0 })
      const forced = yield* (yield* connection.status).pipe(
        Stream.filter((status) => status.type === "forceReconnect"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true })
      )
      const reconnecting = yield* connection.reconnect.pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
      yield* Fiber.join(forced)
      yield* connection.close
      const result = yield* Fiber.join(reconnecting).pipe(Effect.timeout("1 second"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ _tag: "NATSConnectionError", code: "closed" })
      }
    }).pipe(Effect.scoped))

  it.live("reconnect rejects an already closed connection promptly", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory)
      yield* connection.close
      expect((yield* connection.reconnect.pipe(Effect.flip)).code).toBe("closed")
    }).pipe(Effect.scoped))

  for (
    const [name, maxBufferedBytes, payloadSize] of [
      ["inbound payload is independent of an explicitly small outbound budget", 128, 256],
      ["inbound payload above the default outbound budget remains supported", undefined, 8 * 1024 * 1024 + 1]
    ] as const
  ) {
    it.live(name, () =>
      Effect.gen(function*() {
        const peer = yield* harness
        const connection = yield* NATSConnection.make(
          peer.factory,
          maxBufferedBytes === undefined ? {} : { maxBufferedBytes }
        )
        const subscription = yield* connection.subscribe("q")
        const payload = new Uint8Array(payloadSize).fill(7)
        yield* peer.feed(frame(yield* subscription.getID, payload))
        const message = Option.getOrThrow(yield* subscription.stream.pipe(Stream.runHead, Effect.timeout("2 seconds")))
        expect(message.data.length).toBe(payloadSize)
        expect(message.data[0]).toBe(7)
        expect(message.data.at(-1)).toBe(7)
        expect(yield* connection.isClosed).toBe(false)
      }).pipe(Effect.scoped))
  }

  it.live("oversized inbound declarations still fail the independent parser guard", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory)
      const subscription = yield* connection.subscribe("q")
      yield* peer.feed(encoder.encode(`MSG q ${yield* subscription.getID} ${64 * 1024 * 1024 + 1}\r\n`))
      expect(Option.getOrThrow(yield* connection.closed.pipe(Effect.timeout("1 second"))).code).toBe("protocol_error")
    }).pipe(Effect.scoped))

  it.live("header-only messages consume the subscription retained byte budget", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory)
      const subscription = yield* connection.subscribe("q", { maxPendingBytes: retainedSize - 1 })
      yield* peer.feed(frame(yield* subscription.getID, new Uint8Array(), headers))
      expect(Option.getOrThrow(yield* subscription.closed.pipe(Effect.timeout("1 second"))).reason).toContain(
        "byte limit"
      )
      expect(yield* subscription.getPending).toBe(1)
      expect(yield* connection.isClosed).toBe(false)
    }).pipe(Effect.scoped))

  it.live("iterator dequeue releases the same header-inclusive admission charge", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory)
      const subscription = yield* connection.subscribe("q", { maxPendingBytes: retainedSize })
      const delivered = yield* Queue.unbounded<NATSMessage.NATSMessage>()
      const resume = yield* Deferred.make<void>()
      const consuming = yield* subscription.stream.pipe(
        Stream.take(2),
        Stream.runForEach((message) => Queue.offer(delivered, message).pipe(Effect.andThen(Deferred.await(resume)))),
        Effect.forkChild({ startImmediately: true })
      )
      const bytes = frame(yield* subscription.getID, new Uint8Array(), headers)
      yield* peer.feed(bytes)
      expect((yield* Queue.take(delivered)).size).toBe(retainedSize)
      yield* peer.feed(bytes)
      yield* connection.flush
      expect(yield* subscription.isClosed).toBe(false)
      expect(yield* subscription.getPending).toBe(1)
      yield* Deferred.succeed(resume, undefined)
      expect((yield* Queue.take(delivered)).size).toBe(retainedSize)
      yield* Fiber.join(consuming)
    }).pipe(Effect.scoped))

  it.live("callback completion releases header-inclusive bytes before subsequent delivery", () =>
    Effect.gen(function*() {
      const peer = yield* harness
      const connection = yield* NATSConnection.make(peer.factory)
      const delivered = yield* Queue.unbounded<NATSMessage.NATSMessage>()
      const subscription = yield* connection.subscribe("q", {
        maxPendingBytes: retainedSize,
        callback: (_error, value) =>
          Option.match(value, {
            onNone: () => Effect.void,
            onSome: (message) => Queue.offer(delivered, message).pipe(Effect.asVoid)
          })
      })
      const bytes = frame(yield* subscription.getID, new Uint8Array(), headers)
      yield* peer.feed(bytes)
      expect((yield* Queue.take(delivered)).size).toBe(retainedSize)
      yield* subscription.getProcessed.pipe(Effect.repeat({ until: (processed) => processed === 1 }))
      yield* peer.feed(bytes)
      expect((yield* Queue.take(delivered)).size).toBe(retainedSize)
      yield* connection.flush
      expect(yield* subscription.isClosed).toBe(false)
    }).pipe(Effect.scoped))
})
