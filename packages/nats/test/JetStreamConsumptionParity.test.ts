import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Schedule, Stream } from "effect"
import type * as Scope from "effect/Scope"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import type * as JetStreamConsumer from "../src/JetStreamConsumer.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { AckPolicy, DeliverPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSError from "../src/NATSError.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"
import { makeServer } from "./server.ts"

type Fixture = {
  connection: NATSConnection.NATSConnection
  manager: JetStreamManager.JetStreamManager
  client: JetStreamClient.JetStreamClient
  consumer: JetStreamConsumer.Consumer
  name: string
  subject: string
  subscriptions: Array<NATSSubscription.NATSSubscription>
  activeChangeListeners: () => number
  dropIncoming: () => void
}
const withFixture = <A, E, R>(
  count: number,
  run: (fixture: Fixture) => Effect.Effect<A, E, R>,
  config: Partial<T.ConsumerConfig> = {},
  servers = "localhost:4222",
  storage: T.StorageType = StorageType.Memory
) =>
  Effect.gen(function*() {
    const native = yield* NATSConnection.NATSConnection
    const subscriptions: Array<NATSSubscription.NATSSubscription> = []
    let dropping = false
    let changeListeners = 0
    const connection: NATSConnection.NATSConnection = {
      ...native,
      changes: Stream.unwrap(Effect.sync(() => {
        changeListeners++
        return native.changes.pipe(Stream.ensuring(Effect.sync(() => {
          changeListeners--
        })))
      })),
      subscribe: (subject, options) =>
        native.subscribe(subject, options).pipe(Effect.map((subscription) => {
          subscriptions.push(subscription)
          return { ...subscription, stream: subscription.stream.pipe(Stream.filter(() => !dropping)) }
        }))
    }
    const manager = JetStreamManager.make(connection)
    const client = JetStreamClient.make(connection)
    const name = `CONSUMPTION_${crypto.randomUUID().replaceAll("-", "")}`
    const subject = `${name}.orders`
    yield* Effect.acquireRelease(
      manager.streams.add({ name, subjects: [subject], storage }),
      () =>
        manager.streams.delete(name).pipe(
          Effect.catch((error) =>
            error.apiError?.err_code === 10059 ? Effect.void : Effect.gen(function*() {
              const cleanup = yield* NATSConnection.NATSConnection
              yield* JetStreamManager.make(cleanup).streams.delete(name).pipe(
                Effect.catch((cleanupError) =>
                  cleanupError.apiError?.err_code === 10059
                    ? Effect.void
                    : Effect.fail(cleanupError)
                )
              )
            }).pipe(Effect.provide(NATSConnection.layerNode({ servers })))
          ),
          Effect.orDie
        )
    )
    yield* manager.consumers.add(name, { durable_name: "consumer", ack_policy: AckPolicy.Explicit, ...config })
    yield* Effect.forEach(Array.from({ length: count }, (_, index) => index), (index) =>
      client.publish(subject, `${index}`), { concurrency: 16 })
    const consumer = yield* client.consumers.get(name, "consumer")
    return yield* run({
      connection,
      manager,
      client,
      consumer,
      name,
      subject,
      subscriptions,
      activeChangeListeners: () =>
        changeListeners,
      dropIncoming: () => {
        dropping = true
      }
    })
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers })))
const received = (messages: JetStreamConsumer.ConsumerMessages) =>
  messages.stream.pipe(Stream.tap((message) => message.ack), Stream.runCollect)
const statusMatching = (
  messages: JetStreamConsumer.ConsumerMessages,
  predicate: (event: T.ConsumerNotification) => boolean
) =>
  messages.status.pipe(
    Effect.flatMap((stream) => stream.pipe(Stream.filter(predicate), Stream.runHead)),
    Effect.timeout("15 seconds")
  )
const assertNoSubscriptions = (fixture: Fixture) =>
  Effect.forEach(
    fixture.subscriptions,
    (subscription) => subscription.isClosed.pipe(Effect.tap((closed) => Effect.sync(() => expect(closed).toBe(true))))
  ).pipe(Effect.tap(() => Effect.sync(() => expect(fixture.activeChangeListeners()).toBe(0))))
const fetchAll = (fixture: Fixture, options: T.FetchOptions = { max_messages: 1, expires: 1000 }) =>
  fixture.consumer.fetch(options).pipe(Effect.flatMap(received))
const nextMessage = (fixture: Fixture) => fixture.consumer.next().pipe(Effect.map(Option.getOrThrow))
const closeWithinOneSecond = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.exit, Effect.timeout("1 second"))

describe("Official JetStream consumption v3.4.0 cases", () => {
  it.live("consumers - consume", () =>
    withFixture(1000, (f) =>
      Effect.gen(function*() {
        expect(yield* f.consumer.isPullConsumer).toBe(true)
        expect(yield* f.consumer.isPushConsumer).toBe(false)
        expect((yield* f.consumer.info()).num_pending).toBe(1000)
        const messages = yield* f.consumer.consume({ expires: 2000, max_messages: 10 })
        const values = yield* messages.stream.pipe(
          Stream.take(1000),
          Stream.tap((message) => message.ack),
          Stream.runCollect
        )
        expect(values.length).toBe(1000)
        expect(yield* messages.getReceived).toBe(1000)
        expect(yield* messages.getProcessed).toBe(1000)
        expect((yield* f.consumer.info()).num_pending).toBe(0)
        yield* assertNoSubscriptions(f)
      })))

  it.live("consumers - consume callback rejects iter", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume({ callback: (message) => message.ack })
        const error = yield* received(messages).pipe(Effect.flip)
        expect(error.reason).toContain("iterator cannot be used when a callback is registered")
        yield* messages.close
      })))

  it.live("consume - heartbeats", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        f.dropIncoming()
        const messages = yield* f.consumer.consume({ idle_heartbeat: 500, expires: 1000 })
        const notification = yield* statusMatching(messages, (event) => event.type === "heartbeats_missed")
        expect(Option.getOrThrow(notification)).toEqual({ type: "heartbeats_missed", count: 2 })
        yield* messages.close
        expect(yield* received(messages)).toEqual([])
      })))

  it.live("consume - deleted consumer", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume({ expires: 1000 })
        const events: Array<T.ConsumerNotification> = []
        const found = yield* messages.status.pipe(
          Effect.flatMap((stream) =>
            stream.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  events.push(event)
                })
              ),
              Stream.filter((event) => event.type === "consumer_not_found" && event.count > 1),
              Stream.runHead
            )
          ),
          Effect.forkChild
        )
        yield* f.connection.flush
        yield* f.consumer.delete
        yield* Fiber.join(found).pipe(Effect.timeout("15 seconds"))
        expect(events.some((event) => event.type === "consumer_deleted")).toBe(true)
        yield* messages.close
      })), 15_000)

  it.live("consume - sync", () =>
    withFixture(2, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume()
        expect((yield* messages.stream.pipe(Stream.take(2), Stream.runCollect)).map((message) => message.seq))
          .toEqual([1, 2])
        expect(yield* received(messages)).toEqual([])
        yield* assertNoSubscriptions(f)
      })))

  for (const name of ["consume - sub leaks", "consumer - internal close listener"]) {
    it.live(name, () =>
      withFixture(3, (f) =>
        Effect.gen(function*() {
          expect(Option.isSome(yield* f.consumer.next())).toBe(true)
          expect((yield* fetchAll(f)).length).toBe(1)
          const messages = yield* f.consumer.consume({ max_messages: 1 })
          expect((yield* messages.stream.pipe(Stream.take(1), Stream.runCollect)).length).toBe(1)
          const empty = yield* f.consumer.consume({ max_messages: 1 })
          const waiting = yield* received(empty).pipe(Effect.forkChild)
          yield* f.connection.flush
          expect(f.activeChangeListeners()).toBe(1)
          yield* empty.close
          yield* Fiber.join(waiting)
          yield* assertNoSubscriptions(f)
          if (name === "consumer - internal close listener") {
            const closing = yield* f.consumer.consume({ max_messages: 1 })
            const pending = yield* received(closing).pipe(Effect.exit, Effect.forkChild)
            yield* f.connection.flush
            expect(f.activeChangeListeners()).toBe(1)
            yield* f.connection.close
            yield* Fiber.join(pending).pipe(Effect.timeout("1 second"))
            yield* assertNoSubscriptions(f)
          }
        })))
  }

  it.live("consume - drain", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume({ expires: 30_000 })
        const waiting = yield* received(messages).pipe(Effect.exit, Effect.forkChild)
        yield* f.connection.flush
        yield* f.connection.drain.pipe(Effect.timeout("1 second"))
        yield* closeWithinOneSecond(Fiber.join(waiting))
      })))

  for (
    const [name, removeStream, before] of [
      ["consume - stream not found request abort", true, false],
      ["consume - consumer deleted request abort", false, false],
      ["consume - consumer not found request abort", false, true]
    ] as const
  ) {
    it.live(name, () =>
      withFixture(0, (f) =>
        Effect.gen(function*() {
          if (before) yield* f.consumer.delete
          const messages = yield* f.consumer.consume({ expires: 1000, abort_on_missing_resource: true })
          const waiting = yield* received(messages).pipe(Effect.flip, Effect.forkChild)
          yield* f.connection.flush
          if (!before) {
            if (removeStream) yield* f.manager.streams.delete(f.name)
            else yield* f.consumer.delete
          }
          const error = yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
          expect(error.reason.toLowerCase()).toMatch(
            removeStream ? /stream.*(not found|deleted)/ : /consumer.*(not found|deleted)/
          )
        })))
  }

  it.live("consume - consumer bind", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        yield* f.consumer.delete
        const monitored = yield* f.connection.subscribe(`$JS.API.CONSUMER.INFO.${f.name}.consumer`)
        const messages = yield* f.consumer.consume({ expires: 1000, bind: true })
        const event = yield* statusMatching(messages, (event) => event.type === "heartbeats_missed" && event.count > 2)
        expect(Option.isSome(event)).toBe(true)
        expect(yield* monitored.getReceived).toBe(0)
        yield* messages.close
      })))

  it.live("consume - connection close exits", () =>
    withFixture(1, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume({ expires: 2000, callback: (message) => message.ack })
        yield* f.connection.close
        yield* closeWithinOneSecond(messages.closed)
      })))

  it.live("consume - one pending is none", () =>
    withFixture(100, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.consume({ bind: true, max_messages: 1 })
        yield* messages.stream.pipe(
          Stream.take(100),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              expect(yield* messages.getPending).toBe(0)
              expect(yield* messages.getReceived).toBe(message.seq)
              yield* message.ack
            })
          )
        )
      })))

  for (
    const [name, removeStream] of [["consume - stream not found and no responders", true], [
      "consume - consumer not found and no responders",
      false
    ]] as const
  ) {
    it.live(name, () =>
      withFixture(0, (f) =>
        Effect.gen(function*() {
          if (removeStream) yield* f.manager.streams.delete(f.name)
          else yield* f.consumer.delete
          const messages = yield* f.consumer.consume({ expires: 1000 })
          const events: Array<T.ConsumerNotification> = []
          const observing = yield* messages.status.pipe(
            Effect.flatMap((stream) =>
              stream.pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    events.push(event)
                  })
                ),
                Stream.filter((event) => event.type === "heartbeats_missed" && event.count === 3),
                Stream.runHead
              )
            ),
            Effect.forkChild
          )
          const waiting = yield* messages.stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
          yield* Fiber.join(observing).pipe(Effect.timeout("10 seconds"))
          expect(events.some((event) => event.type === "no_responders")).toBe(true)
          expect(events.some((event) => event.type === (removeStream ? "stream_not_found" : "consumer_not_found")))
            .toBe(true)
          if (removeStream) {
            yield* f.manager.streams.add({ name: f.name, subjects: [f.subject], storage: StorageType.Memory })
          }
          yield* f.client.publish(f.subject, "recovered")
          yield* f.manager.consumers.add(f.name, { durable_name: "consumer", ack_policy: AckPolicy.Explicit })
          expect((yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds")))[0].string()).toBe("recovered")
        })), 15_000)
  }

  for (
    const [name, limit] of [["consume - max_waiting throttles", "waiting"], [
      "consume - max_bytes throttles",
      "bytes"
    ]] as const
  ) {
    it.live(name, () =>
      withFixture(limit === "bytes" ? 1 : 0, (f) =>
        Effect.gen(function*() {
          if (limit === "waiting") yield* f.consumer.next({ expires: 2000 }).pipe(Effect.forkChild)
          yield* f.connection.flush
          const messages = yield* f.consumer.consume({ expires: 1000, ...(limit === "bytes" ? { max_bytes: 8 } : {}) })
          let missed = false
          yield* statusMatching(messages, (event) => {
            if (event.type === "heartbeats_missed") missed = true
            return missed && event.type === "next"
          })
          yield* messages.close
        }), limit === "waiting" ? { max_waiting: 1 } : {}))
  }

  for (
    const [name, published, maximum, expected] of [["fetch - no messages", 0, 100, 0], [
      "fetch - less messages",
      1,
      10,
      1
    ], ["fetch - exactly messages", 200, 100, 100]] as const
  ) {
    it.live(name, () =>
      withFixture(published, (f) =>
        Effect.gen(function*() {
          expect((yield* f.consumer.info(true)).num_pending).toBe(published)
          const messages = yield* f.consumer.fetch({ max_messages: maximum, expires: 1000 })
          expect((yield* received(messages)).length).toBe(expected)
          expect(yield* messages.getReceived).toBe(expected)
          expect(yield* messages.getProcessed).toBe(expected)
        })), 15_000)
  }

  for (const name of ["fetch - deleted consumer", "next - deleted consumer"]) {
    it.live(name, () =>
      withFixture(0, (f) =>
        Effect.gen(function*() {
          const pending: Effect.Effect<
            void,
            NATSError.JetStreamConsumerError | NATSError.JetStreamMessageError,
            Scope.Scope
          > = name.startsWith("next")
            ? f.consumer.next({ expires: 3000 }).pipe(Effect.asVoid)
            : fetchAll(f, { expires: 3000 }).pipe(Effect.asVoid)
          const waiting = yield* pending.pipe(Effect.flip, Effect.forkChild)
          yield* Effect.gen(function*() {
            while ((yield* f.consumer.info()).num_waiting === 0) yield* Effect.sleep("10 millis")
          }).pipe(Effect.timeout("1 second"))
          yield* f.consumer.delete
          expect((yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))).reason.toLowerCase()).toContain(
            "consumer deleted"
          )
        })), 15_000)
  }

  for (const name of ["fetch - listener leaks", "next - sub leaks", "next - listener leaks"]) {
    it.live(name, () =>
      withFixture(name === "next - listener leaks" ? 1 : 0, (f) =>
        Effect.gen(function*() {
          if (name === "next - listener leaks") {
            for (let index = 1; index <= 101; index++) {
              const message = yield* nextMessage(f)
              expect(message.info.deliveryCount).toBe(index)
              yield* message.nak()
            }
          } else if (name.startsWith("next")) expect(yield* f.consumer.next({ expires: 1000 })).toEqual(Option.none())
          else expect(yield* fetchAll(f)).toEqual([])
          yield* assertNoSubscriptions(f)
        })), 15_000)
  }

  it.live("fetch - sync", () =>
    withFixture(2, (f) =>
      Effect.gen(function*() {
        expect((yield* fetchAll(f, { max_messages: 2 })).map((message) => message.seq)).toEqual([1, 2])
      })))

  for (const name of ["fetch - consumer bind", "next - consumer bind"]) {
    it.live(name, () =>
      withFixture(1, (f) =>
        Effect.gen(function*() {
          const monitored = yield* f.connection.subscribe(`$JS.API.CONSUMER.INFO.${f.name}.consumer`)
          if (name.startsWith("fetch")) {
            expect((yield* fetchAll(f, { expires: 1000, bind: true })).length).toBe(1)
            expect(yield* fetchAll(f, { expires: 1000, bind: true })).toEqual([])
          } else {
            const message = yield* f.consumer.next({ expires: 1000, bind: true })
            yield* Option.getOrThrow(message).ack
            expect(yield* f.consumer.next({ expires: 1000, bind: true })).toEqual(Option.none())
            yield* f.consumer.delete
            expect((yield* f.consumer.next({ expires: 1000, bind: true }).pipe(Effect.flip)).reason.toLowerCase())
              .toContain("responder")
          }
          expect(yield* monitored.getReceived).toBe(0)
        })))
  }

  it.live("fetch - exceeding max_messages will stop", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* fetchAll(f, { max_messages: 1000 }).pipe(Effect.flip)).reason.toLowerCase()).toContain(
          "exceeded maxrequestbatch of 100"
        )
      }), { max_batch: 100 }))

  it.live("fetch - timer is based on idle_hb", () =>
    withFixture(1, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.consumer.fetch({ expires: 2000, max_messages: 10, idle_heartbeat: 500 })
        const notification = yield* statusMatching(messages, (event) => event.type === "heartbeats_missed").pipe(
          Effect.forkChild
        )
        let count = 0
        const error = yield* messages.stream.pipe(
          Stream.tap((message) =>
            message.ack.pipe(Effect.andThen(Effect.sync(() => {
              count++
              f.dropIncoming()
            })))
          ),
          Stream.runDrain,
          Effect.flip
        )
        expect(error.reason).toContain("heartbeats missed")
        expect(count).toBe(1)
        expect(Option.getOrThrow(yield* Fiber.join(notification))).toMatchObject({
          type: "heartbeats_missed",
          count: 2
        })
      })))

  for (const name of ["fetch - connection close exits", "next - connection close exits"]) {
    it.live(name, () =>
      withFixture(0, (f) =>
        Effect.gen(function*() {
          const pending: Effect.Effect<
            void,
            NATSError.JetStreamConsumerError | NATSError.JetStreamMessageError,
            Scope.Scope
          > = name.startsWith("next")
            ? f.consumer.next({ expires: 30_000 })
            : fetchAll(f, { expires: 30_000 })
          const waiting = yield* pending.pipe(Effect.exit, Effect.forkChild)
          yield* f.connection.flush
          yield* f.connection.close
          yield* closeWithinOneSecond(Fiber.join(waiting))
        })))
  }

  for (
    const [name, removeStream] of [
      ["fetch - stream not found and no responders", true],
      ["fetch - consumer not found and no responders", false],
      ["next - stream not found and no responders", true],
      ["next - consumer not found and no responders", false]
    ] as const
  ) {
    it.live(name, () =>
      withFixture(0, (f) =>
        Effect.gen(function*() {
          if (removeStream) yield* f.manager.streams.delete(f.name)
          else yield* f.consumer.delete
          const pending: Effect.Effect<
            void,
            NATSError.JetStreamConsumerError | NATSError.JetStreamMessageError,
            Scope.Scope
          > = name.startsWith("next")
            ? f.consumer.next({ expires: 1000 }).pipe(Effect.asVoid)
            : fetchAll(f, { expires: 1000 }).pipe(Effect.asVoid)
          expect((yield* pending.pipe(Effect.flip)).reason.toLowerCase()).toContain("responder")
          if (removeStream) {
            yield* f.manager.streams.add({ name: f.name, subjects: [f.subject], storage: StorageType.Memory })
          }
          yield* f.manager.consumers.add(f.name, { durable_name: "consumer", ack_policy: AckPolicy.Explicit })
          yield* f.client.publish(f.subject, "recreated")
          expect((yield* nextMessage(f)).string()).toBe("recreated")
        })))
  }

  it.live("next - basics", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* f.consumer.info(true)).num_pending).toBe(0)
        expect(yield* f.consumer.next({ expires: 1000 })).toEqual(Option.none())
        yield* f.client.publish(f.subject, "one")
        yield* f.client.publish(f.subject, "two")
        expect((yield* f.consumer.info()).num_pending).toBe(2)
        const first = yield* nextMessage(f)
        expect(first.seq).toBe(1)
        yield* first.ackAck()
        expect((yield* f.consumer.info()).num_pending).toBe(1)
        expect((yield* nextMessage(f)).seq).toBe(2)
      })))

  it.live("next - delivery count", () =>
    withFixture(1, (f) =>
      Effect.gen(function*() {
        expect((yield* nextMessage(f)).info.deliveryCount).toBe(1)
        yield* Effect.sleep(1500)
        expect((yield* nextMessage(f)).info.deliveryCount).toBe(2)
        yield* Effect.sleep(1500)
        expect(yield* f.consumer.next({ expires: 1000 })).toEqual(Option.none())
      }), { max_deliver: 2, ack_wait: 1_000_000_000 }))

  it.live("next - max_bytes returns fast", () =>
    withFixture(1, (f) =>
      Effect.gen(function*() {
        const started = Date.now()
        const error = yield* fetchAll(f, { expires: 30_000, max_bytes: 8 }).pipe(Effect.flip)
        expect(error.reason.toLowerCase()).toContain("maxbytes")
        expect(Date.now() - started).toBeLessThan(1000)
      })))

  it.live("consumer reset - basic (no seq)", () =>
    withFixture(5, (f) =>
      Effect.gen(function*() {
        yield* fetchAll(f, { max_messages: 3, expires: 1000 })
        yield* f.connection.flush
        const stream = yield* f.client.streams.get(f.name)
        const reset = yield* stream.resetConsumer("consumer")
        expect(reset.name).toBe("consumer")
        expect(reset.stream_name).toBe(f.name)
        expect(typeof reset.reset_seq).toBe("number")
        expect(reset.delivered.consumer_seq).toBe(0)
        expect(reset.num_redelivered).toBe(0)
      })))

  it.live("consumer reset - with seq", () =>
    withFixture(5, (f) =>
      Effect.gen(function*() {
        const stream = yield* f.client.streams.get(f.name)
        expect((yield* stream.resetConsumer("consumer", 3)).reset_seq).toBe(3)
        expect((yield* nextMessage(f)).seq).toBeGreaterThanOrEqual(3)
      })))

  it.live("consumer reset - invalid seq", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        for (const sequence of [-1, 1.5]) {
          expect((yield* f.manager.consumers.reset(f.name, "consumer", sequence).pipe(Effect.flip)).reason).toContain(
            "non-negative integer"
          )
        }
      })))

  it.live("consumer reset - version gate", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        const older = {
          ...f.connection,
          info: Option.map(f.connection.info, (info) => ({ ...info, version: "2.13.0" }))
        }
        const stream = yield* JetStreamClient.make(older).streams.get(f.name)
        expect((yield* stream.resetConsumer("consumer").pipe(Effect.flip)).reason).toContain(
          "requires NATS server 2.14.0"
        )
      })))

  it.live("consumer reset - by_start_sequence allowed at/above", () =>
    withFixture(5, (f) =>
      Effect.gen(function*() {
        expect((yield* f.manager.consumers.reset(f.name, "consumer", 3)).reset_seq).toBe(3)
        expect((yield* f.manager.consumers.reset(f.name, "consumer", 4)).reset_seq).toBe(4)
      }), { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 3 }))

  it.live("consumer reset - by_start_sequence rejects below", () =>
    withFixture(10, (f) =>
      Effect.gen(function*() {
        expect((yield* f.manager.consumers.reset(f.name, "consumer", 2).pipe(Effect.flip)).reason).toContain(
          "below start seq"
        )
      }), { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 5 }))

  it.live("consumer reset - rejects last policy server-side", () =>
    withFixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* f.manager.consumers.reset(f.name, "consumer", 1).pipe(Effect.flip))._tag).toBe(
          "JetStreamConsumerAPIError"
        )
      }), { deliver_policy: DeliverPolicy.Last }))
  for (const mode of ["idle processing", "reconnect", "broker restart"] as const) {
    it.live(
      `admitted callback batch survives ${mode}`,
      () =>
        Effect.gen(function*() {
          const server = mode === "broker restart" ? yield* makeServer() : undefined
          return yield* withFixture(
            100,
            (f) =>
              Effect.gen(function*() {
                const gate = yield* Deferred.make<void>()
                const complete = yield* Deferred.make<void>()
                const processed: Array<number> = []
                const messages = yield* f.consumer.consume({
                  max_messages: 100,
                  expires: 1000,
                  callback: (message) =>
                    Effect.gen(function*() {
                      yield* Deferred.await(gate)
                      yield* message.ack
                      processed.push(message.seq)
                      if (processed.length === 100) yield* Deferred.succeed(complete, undefined)
                    })
                })
                yield* messages.getReceived.pipe(
                  Effect.flatMap((count) => count === 100 ? Effect.void : Effect.fail("Awaiting batch admission")),
                  Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 })
                )
                const subscriptions = f.subscriptions.length
                yield* Effect.sleep("2 seconds")
                expect(yield* messages.getReceived).toBe(100)
                expect(processed).toEqual([])
                expect(f.subscriptions).toHaveLength(subscriptions)
                if (mode !== "idle processing") {
                  if (server) {
                    yield* server.stop
                    yield* server.start
                    yield* f.connection.state.pipe(
                      Effect.flatMap((state) =>
                        state.state === "Connected" ? Effect.void : Effect.fail("Awaiting reconnect")
                      ),
                      Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 400 })
                    )
                  } else yield* f.connection.reconnect
                  yield* f.connection.flush
                  yield* Effect.suspend(() =>
                    f.subscriptions.length > subscriptions
                      ? Effect.void :
                      Effect.fail("Awaiting replacement pull subscription")
                  )
                    .pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }))
                }
                yield* Deferred.succeed(gate, undefined)
                yield* Deferred.await(complete).pipe(Effect.timeout("10 seconds"))
                expect(processed).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
                expect(yield* messages.getReceived).toBe(100)
                yield* messages.close
              }),
            {},
            server?.url ?? "localhost:4222",
            server ? StorageType.File : StorageType.Memory
          )
        }).pipe(Effect.scoped),
      20_000
    )
  }
})
