import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as Client from "../src/JetStreamClient.ts"
import * as Manager from "../src/JetStreamManager.ts"
import { StorageType } from "../src/JetStreamTypes.ts"
import type * as NATSConnection from "../src/NATSConnection.ts"
import * as Node from "../src/NATSNodeConnection.ts"

const fixture = Effect.gen(function*() {
  const native = yield* Node.make({ reconnectTimeWait: 0, reconnectJitter: 0 })
  const name = "BACKPRESSURE_" + crypto.randomUUID().replaceAll("-", "")
  const manager = Manager.make(native)
  yield* Effect.acquireRelease(
    manager.streams.add({ name, subjects: [name], storage: StorageType.Memory }),
    () => manager.streams.delete(name).pipe(Effect.orDie)
  )
  const raw = yield* Queue.unbounded<number>()
  const creations: Array<string> = []
  const connection: NATSConnection.NATSConnection = {
    ...native,
    request: (subject, payload, options) =>
      native.request(subject, payload, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (subject.startsWith(`$JS.API.CONSUMER.CREATE.${name}.`)) creations.push(subject)
          })
        )
      ),
    subscribe: (subject, options) =>
      native.subscribe(subject, options).pipe(Effect.map((subscription) => ({
        ...subscription,
        stream: subscription.stream.pipe(Stream.tap((message) =>
          message.subject === name && Option.isSome(message.reply) && message.reply.value.startsWith("$JS.ACK.")
            ? Queue.offer(raw, Number(new TextDecoder().decode(message.data))).pipe(Effect.asVoid)
            : Effect.void
        ))
      })))
  }
  const client = Client.make(connection)
  for (let sequence = 1; sequence <= 10; sequence++) yield* client.publish(name, String(sequence))
  const consumer = yield* client.consumers.get(name)
  return { native, consumer, raw, creations }
})

describe("real broker ordered pull mailbox backpressure", () => {
  for (const max_messages of [1, 3]) {
    it.effect(
      `paused mailbox${max_messages} survives heartbeat windows without ordered recreation`,
      () =>
        Effect.gen(function*() {
          const { consumer, raw, creations } = yield* fixture
          const initialCreations = creations.length
          expect(initialCreations).toBe(1)
          const messages = yield* consumer.consume({ max_messages, idle_heartbeat: 500, expires: 1000 })
          // No iterator runs yet: the first batch fills the mailbox and the next raw delivery blocks admission.
          for (let sequence = 1; sequence <= max_messages + 1; sequence++) expect(yield* Queue.take(raw)).toBe(sequence)
          yield* TestClock.adjust("3 seconds")
          expect(creations).toHaveLength(initialCreations)
          let expected = 1
          yield* messages.stream.pipe(
            Stream.take(10),
            Stream.runForEach((message) =>
              Effect.sync(() => {
                expect(message.seq).toBe(expected++)
              })
            )
          )
          expect(expected).toBe(11)
          expect(creations).toHaveLength(initialCreations)
          yield* messages.close
        }).pipe(Effect.scoped),
      { timeout: 15_000 }
    )

    it.effect(
      `reconnect while mailbox${max_messages} is full preserves all ten ordered sequences`,
      () =>
        Effect.gen(function*() {
          const { native, consumer, raw, creations } = yield* fixture
          const initialCreations = creations.length
          const messages = yield* consumer.consume({ max_messages, idle_heartbeat: 500, expires: 1000 })
          for (let sequence = 1; sequence <= max_messages + 1; sequence++) expect(yield* Queue.take(raw)).toBe(sequence)
          const recreated = yield* (yield* messages.status).pipe(
            Stream.filter((event) => event.type === "ordered_consumer_recreated"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true })
          )
          yield* native.reconnect
          expect(Option.isSome(yield* Fiber.join(recreated))).toBe(true)
          expect(creations).toHaveLength(initialCreations + 1)
          let expected = 1
          yield* messages.stream.pipe(
            Stream.take(10),
            Stream.runForEach((message) =>
              Effect.sync(() => {
                expect(message.seq).toBe(expected++)
              })
            )
          )
          expect(expected).toBe(11)
          yield* messages.close
        }).pipe(Effect.scoped),
      { timeout: 15_000 }
    )
  }
  it.effect(
    "blocked callback across two reconnects preserves mailbox admissions and every sequence",
    () =>
      Effect.gen(function*() {
        const { native, consumer, raw, creations } = yield* fixture
        const initialCreations = creations.length
        const callbackStarted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        const recreations = yield* Queue.unbounded<void>()
        let expected = 1
        const messages = yield* consumer.consume({
          max_messages: 2,
          idle_heartbeat: 500,
          expires: 1000,
          callback: (message) =>
            Effect.gen(function*() {
              if (message.seq === 1) yield* Deferred.succeed(callbackStarted, undefined)
              yield* Deferred.await(release)
              expect(message.seq).toBe(expected++)
              if (expected === 11) yield* Deferred.succeed(complete, undefined)
            })
        })
        yield* (yield* messages.status).pipe(
          Stream.filter((event) => event.type === "ordered_consumer_recreated"),
          Stream.runForEach(() => Queue.offer(recreations, undefined)),
          Effect.forkChild({ startImmediately: true })
        )
        expect(yield* Queue.take(raw)).toBe(1)
        expect(yield* Queue.take(raw)).toBe(2)
        yield* Deferred.await(callbackStarted)
        yield* native.reconnect
        yield* Queue.take(recreations)
        expect(yield* Queue.take(raw)).toBe(3)
        expect(yield* Queue.take(raw)).toBe(4)
        // Callback1 still owns its message; messages2 and3 fill the mailbox, so raw4 cannot be retained yet.
        yield* TestClock.adjust(0)
        yield* native.reconnect
        yield* Queue.take(recreations)
        expect(creations).toHaveLength(initialCreations + 2)
        yield* Deferred.succeed(release, undefined)
        yield* Effect.raceFirst(Deferred.await(complete), messages.closed.pipe(Effect.andThen(Effect.never)))
        expect(expected).toBe(11)
        expect(creations).toHaveLength(initialCreations + 2)
        yield* messages.close
      }).pipe(Effect.scoped),
    { timeout: 15_000 }
  )
})
