import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import type * as JetStreamConsumer from "../src/JetStreamConsumer.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { AckPolicy, PersistMode, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"

interface Fixture {
  readonly connection: NATSConnection.NATSConnection
  readonly client: JetStreamClient.JetStreamClient
  readonly manager: JetStreamManager.JetStreamManager
  readonly name: string
  readonly subject: string
  readonly subscriptions: Array<NATSSubscription.NATSSubscription>
  readonly created: Queue.Queue<NATSSubscription.NATSSubscription>
}
const fixture = <A, E, R>(
  count: number,
  run: (fixture: Fixture) => Effect.Effect<A, E, R>,
  config: Partial<T.StreamConfig> = {},
  options: NATSOptions.NodeConnectionOptions = {},
  payload = ""
) =>
  Effect.gen(function*() {
    const native = yield* NATSConnection.NATSConnection
    const subscriptions: Array<NATSSubscription.NATSSubscription> = []
    const created = yield* Queue.unbounded<NATSSubscription.NATSSubscription>()
    const connection: NATSConnection.NATSConnection = {
      ...native,
      subscribe: (subject, options) =>
        native.subscribe(subject, options).pipe(
          Effect.tap((sub) =>
            Effect.sync(() => subscriptions.push(sub)).pipe(Effect.andThen(Queue.offer(created, sub)))
          )
        )
    }
    const manager = JetStreamManager.make(connection)
    const client = JetStreamClient.make(connection)
    const name = `FACADE_${crypto.randomUUID().replaceAll("-", "")}`
    const subject = `${name}.orders`
    yield* Effect.acquireRelease(
      manager.streams.add({ name, subjects: [`${name}.>`], storage: StorageType.Memory, ...config }),
      () => manager.streams.delete(name).pipe(Effect.ignore)
    )
    yield* Effect.forEach(Array.from({ length: count }, (_, index) => index), () => client.publish(subject, payload), {
      concurrency: 16
    })
    return yield* run({ connection, manager, client, name, subject, subscriptions, created })
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222", ...options })))
const consumer = (fixture: Fixture, config: Partial<T.ConsumerConfig> = {}) =>
  fixture.manager.consumers.add(fixture.name, { durable_name: "c", ack_policy: AckPolicy.Explicit, ...config }).pipe(
    Effect.andThen(fixture.client.consumers.get(fixture.name, "c"))
  )
const all = (messages: JetStreamConsumer.ConsumerMessages) =>
  messages.stream.pipe(Stream.tap((message) => message.ack), Stream.runCollect)
const collectStatus = (messages: JetStreamConsumer.ConsumerMessages) =>
  messages.status.pipe(Effect.flatMap(Stream.runCollect), Effect.forkScoped({ startImmediately: true }))
const capabilityConnection = (connection: NATSConnection.NATSConnection, version: string) => ({
  ...connection,
  info: Option.some({ ...Option.getOrThrow(connection.info), version })
})

describe("Exact modern consumer and stream facade laws", () => {
  it.live("consumers - min supported server", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const client = JetStreamClient.make(capabilityConnection(f.connection, "2.9.2"))
        for (const name of [undefined, "c"]) {
          const error = yield* client.consumers.get(f.name, name).pipe(Effect.flip)
          expect(error.reason).toContain("2.10")
        }
      })))

  it.live("consumers - get", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* f.client.consumers.get("missing", "c").pipe(Effect.flip)).reason).toMatch(/stream not found/i)
        expect((yield* f.client.consumers.get(f.name, "missing").pipe(Effect.flip)).reason).toMatch(
          /consumer not found/i
        )
        const c = yield* consumer(f)
        expect((yield* c.info()).name).toBe("c")
      })))

  it.live("consumers - delete", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        expect(yield* c.delete).toBe(true)
        expect((yield* f.client.consumers.get(f.name, "c").pipe(Effect.flip)).reason).toMatch(/consumer not found/i)
      })))

  it.live("consumers - info", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        const cached = yield* c.info(false)
        const fresh = yield* f.manager.consumers.info(f.name, "c")
        expect({ ...cached, ts: "" }).toEqual({ ...fresh, ts: "" })
        expect(cached.num_pending).toBe(0)
        yield* f.client.publish(f.subject)
        expect(yield* c.info(true)).toEqual(cached)
        expect((yield* c.info()).num_pending).toBe(1)
        expect((yield* c.info(true)).num_pending).toBe(1)
        yield* c.delete
        expect((yield* c.info().pipe(Effect.flip)).reason).toMatch(/consumer not found/i)
      })))

  it.live("consumers - push consumer on get", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        yield* f.manager.consumers.add(f.name, {
          durable_name: "c",
          ack_policy: AckPolicy.Explicit,
          deliver_subject: yield* f.connection.createInbox
        })
        expect((yield* f.client.consumers.get(f.name, "c").pipe(Effect.flip)).reason).toMatch(/not a pull consumer/i)
      })))

  it.live("consumers - fetch heartbeats", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        const messages = yield* c.fetch({ max_messages: 100, idle_heartbeat: 500, expires: 5000 })
        const statuses = yield* collectStatus(messages)
        const reader = yield* all(messages).pipe(Effect.forkChild)
        const sub = yield* Queue.take(f.created)
        yield* sub.resubscribe(`${f.name}.lost.heartbeats`)
        const error = yield* Fiber.join(reader).pipe(Effect.flip)
        expect(error.reason).toMatch(/heartbeats missed/i)
        const events = yield* Fiber.join(statuses)
        expect(events.filter((event) => event.type === "heartbeats_missed")).toEqual([
          { type: "heartbeats_missed", count: 2 }
        ])
      })))

  it.live("consumers - bad options", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        expect((yield* c.consume({ max_messages: 100, max_bytes: 100 }).pipe(Effect.flip)).reason).toMatch(/exclusive/i)
        expect((yield* c.consume({ expires: 500 }).pipe(Effect.flip)).reason).toMatch(/1000/)
      })))

  it.live("consumers - should be able to consume and pull", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        const finite = Effect.scoped(c.fetch({ expires: 1000 }).pipe(Effect.flatMap(all)))
        const continuous = Effect.scoped(Effect.gen(function*() {
          const messages = yield* c.consume({ expires: 1000 })
          const status = yield* messages.status
          yield* status.pipe(
            Stream.filter((event) => event.type === "discard"),
            Stream.take(1),
            Stream.runDrain
          )
          yield* messages.close
          return yield* all(messages)
        }))
        expect(yield* Effect.all([finite, finite, continuous, continuous], { concurrency: "unbounded" }))
          .toEqual([[], [], [], []])
      })))

  it.live("consumers - discard notifications", () =>
    fixture(1, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        const messages = yield* c.consume({ expires: 1000, max_messages: 101 })
        const status = yield* messages.status
        const discard = yield* status.pipe(
          Stream.filter((event) => event.type === "discard"),
          Stream.runHead,
          Effect.forkChild
        )
        const reader = yield* all(messages).pipe(Effect.forkChild)
        expect(Option.getOrThrow(yield* Fiber.join(discard))).toMatchObject({ type: "discard", messagesLeft: 100 })
        yield* messages.close
        expect((yield* Fiber.join(reader)).length).toBe(1)
      })))

  it.live("consumers - threshold_messages", () =>
    fixture(1000, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f, { ack_policy: AckPolicy.None })
        const messages = yield* c.consume({ expires: 30000 })
        const statuses = yield* collectStatus(messages)
        const values = yield* messages.stream.pipe(
          Stream.takeUntil((message) => message.info.pending === 0),
          Stream.runCollect
        )
        yield* messages.close
        const pulls = (yield* Fiber.join(statuses)).filter((event) => event.type === "next")
        expect(values.map((message) => message.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1))
        expect(pulls[0]?.options.batch).toBe(100)
        expect(pulls.slice(1)).toHaveLength(40)
        expect(pulls.slice(1).every((event) => event.options.batch === 25)).toBe(true)
      })))

  it.live("consumers - threshold_messages bytes", () =>
    fixture(1000, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f, { ack_policy: AckPolicy.None })
        const messages = yield* c.consume({ expires: 1000, max_bytes: 1100, threshold_bytes: 1 })
        const statuses = yield* collectStatus(messages)
        const values = yield* messages.stream.pipe(
          Stream.takeUntil((message) => message.info.pending === 0),
          Stream.runCollect
        )
        yield* messages.close
        const events = yield* Fiber.join(statuses)
        expect(values.map((message) => message.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1))
        const pulls = events.filter((event) => event.type === "next")
        expect(pulls.length).toBeGreaterThan(1)
        expect(pulls.every((event) => event.options.max_bytes > 0 && event.options.max_bytes <= 1100)).toBe(true)
        // Upstream marks its own paired-discard total of996 as FIXME; full1000 sequences is the native delivery law.
      })))

  it.live("consumers - sub leaks fetch()", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const c = yield* consumer(f)
        const messages = yield* c.fetch({ expires: 1000 })
        expect(yield* all(messages)).toEqual([])
        for (const sub of f.subscriptions) expect(yield* sub.isClosed).toBe(true)
        yield* f.connection.flush
      })))

  it.live("consumers - inboxPrefix is respected", () =>
    fixture(
      0,
      (f) =>
        Effect.gen(function*() {
          const c = yield* consumer(f)
          const messages = yield* c.consume()
          const sub = yield* Queue.take(f.created)
          expect(yield* sub.getSubject).toMatch(/^native\.custom\./)
          yield* messages.close
          expect(yield* all(messages)).toEqual([])
        }),
      {},
      { inboxPrefix: "native.custom" }
    ))

  it.live.each([false, true])(
    "consumers - callback processed cachedInfo=%s",
    (cachedInfo) =>
      fixture(2, (f) =>
        Effect.gen(function*() {
          const info = yield* f.manager.consumers.add(f.name, { durable_name: "c", ack_policy: AckPolicy.Explicit })
          let heardInfo = false
          const infoObserver = yield* f.connection.subscribe(`$JS.API.CONSUMER.INFO.${f.name}.c`, {
            callback: () => {
              heardInfo = true
            }
          })
          yield* f.connection.flush
          const c = cachedInfo
            ? yield* f.client.consumers.getConsumerFromInfo(info)
            : yield* f.client.consumers.get(f.name, "c")
          const delivered = yield* Deferred.make<void>()
          const messages = yield* c.consume({
            callback: (message) =>
              message.ack.pipe(
                Effect.andThen(message.info.pending === 0 ? Deferred.succeed(delivered, undefined) : Effect.void),
                Effect.asVoid
              )
          })
          yield* Deferred.await(delivered)
          yield* messages.close
          expect(yield* messages.getProcessed).toBe(2)
          expect(yield* messages.getReceived).toBe(2)
          expect(heardInfo).toBe(!cachedInfo)
          yield* infoObserver.unsubscribe()
        }))
  )

  it.live("streams - get", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* f.client.streams.get("missing").pipe(Effect.flip)).reason).toMatch(/stream not found/i)
        const stream = yield* f.client.streams.get(f.name)
        expect(stream.name).toBe(f.name)
        yield* f.manager.streams.delete(f.name)
        expect((yield* stream.info().pipe(Effect.flip)).reason).toMatch(/stream not found/i)
      })))

  it.live("streams - consumers", () =>
    fixture(
      1,
      (f) =>
        Effect.gen(function*() {
          const stream = yield* f.client.streams.get(f.name)
          const stored = Option.getOrThrow(yield* stream.getMessage({ seq: 1 }))
          expect(yield* stored.json()).toEqual({ hello: "world" })
          expect((yield* stream.getConsumer("c").pipe(Effect.flip)).reason).toMatch(/consumer not found/i)
          yield* f.manager.consumers.add(f.name, { durable_name: "c", ack_policy: AckPolicy.Explicit })
          const c = yield* stream.getConsumer("c")
          expect(yield* Option.getOrThrow(yield* c.next()).json()).toEqual({ hello: "world" })
        }),
      {},
      {},
      JSON.stringify({ hello: "world" })
    ))

  it.live("streams - delete message", () =>
    fixture(3, (f) =>
      Effect.gen(function*() {
        const stream = yield* f.client.streams.get(f.name)
        expect(Option.getOrThrow(yield* stream.getMessage({ seq: 2 })).seq).toBe(2)
        expect(yield* stream.deleteMessage(2, true)).toBe(true)
        expect(yield* stream.getMessage({ seq: 2 })).toEqual(Option.none())
        expect((yield* stream.info(false, { deleted_details: true })).state.deleted).toEqual([2])
      })))

  it.live("streams - first_seq", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        expect((yield* f.manager.streams.info(f.name)).config.first_seq).toBe(50)
        expect((yield* f.client.publish(f.subject)).seq).toBe(50)
      }), { first_seq: 50 }))

  it.live("streams - first_seq fails if wrong server", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const manager = JetStreamManager.make(capabilityConnection(f.connection, "2.9.2"))
        const error = yield* manager.streams.add({ name: `${f.name}_OLD`, first_seq: 50 }).pipe(Effect.flip)
        expect(error.reason).toMatch(/2\.10\.0/)
      })))

  it.live("streams - persist mode", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const defaultInfo = yield* f.manager.streams.info(f.name)
        expect(defaultInfo.config.persist_mode).toBeUndefined()
        expect(defaultInfo.config.metadata?.["_nats.req.level"]).toBe("0")
        const asyncName = `${f.name}_ASYNC`
        const asyncInfo = yield* Effect.acquireRelease(
          f.manager.streams.add({ name: asyncName, subjects: [asyncName], persist_mode: PersistMode.Async }),
          () => f.manager.streams.delete(asyncName).pipe(Effect.ignore)
        )
        expect(asyncInfo.config.persist_mode).toBe(PersistMode.Async)
        expect(asyncInfo.config.metadata?.["_nats.req.level"]).toBe("2")
        // @ts-expect-error Broker rejects changing immutable persistence mode.
        const error = yield* f.manager.streams.update(asyncName, { persist_mode: PersistMode.Default }).pipe(
          Effect.flip
        )
        expect(error.reason).toMatch(/change persist mode/)
      }), { persist_mode: PersistMode.Default }))

  it.live("direct consumer - next", () =>
    fixture(3, (f) =>
      Effect.gen(function*() {
        const c = yield* f.manager.direct.getConsumer(f.name, { seq: 0 })
        for (const seq of [1, 2, 3]) expect(Option.getOrThrow(yield* c.next).seq).toBe(seq)
        expect(yield* c.next).toEqual(Option.none())
      }), { allow_direct: true }))

  it.live("direct consumer - batch", () =>
    fixture(100, (f) =>
      Effect.gen(function*() {
        const c = yield* f.manager.direct.getConsumer(f.name, { seq: 0 })
        const first = yield* c.fetch({ batch: 5 })
        const messages = yield* Stream.runCollect(first.stream)
        expect(messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5])
        expect(messages.at(-1)?.pending).toBe(95)
        expect(Option.getOrThrow(yield* c.next).seq).toBe(6)
        const rest = yield* c.fetch()
        const remaining = yield* Stream.runCollect(rest.stream)
        expect(remaining.map((message) => message.seq)).toEqual(Array.from({ length: 94 }, (_, index) => index + 7))
        expect(remaining.at(-1)?.pending).toBe(0)
      }), { allow_direct: true }))

  it.live("direct consumer - consume", () =>
    fixture(100, (f) =>
      Effect.gen(function*() {
        const c = yield* f.manager.direct.getConsumer(f.name, { seq: 0 })
        const nexts = yield* Queue.unbounded<number>()
        const watcher = yield* c.status.pipe(
          Stream.filter((event) => event.type === "next"),
          Stream.runForEach((event) => Queue.offer(nexts, event.options.batch)),
          Effect.forkChild
        )
        const messages = yield* c.consume({ batch: 7 })
        const values = yield* messages.stream.pipe(
          Stream.rechunk(1),
          Stream.takeUntil((message) => message.pending === 0),
          Stream.runCollect
        )
        yield* messages.stop()
        yield* Fiber.interrupt(watcher)
        expect(values.map((message) => message.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
        expect(yield* messages.getProcessed).toBe(100)
        expect((yield* Queue.takeAll(nexts)).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(100)
      }), { allow_direct: true }))

  it.live("direct - version checks", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const api = JetStreamManager.make(capabilityConnection(f.connection, "2.0.0")).direct
        const operations = [
          api.getMessage(f.name, { start_time: new Date() }).pipe(Effect.asVoid),
          api.getBatch(f.name, { seq: 1, batch: 100 }).pipe(Effect.asVoid),
          api.getLastMessagesFor(f.name, { multi_last: [f.subject] }).pipe(Effect.asVoid)
        ]
        for (const operation of operations) expect((yield* operation.pipe(Effect.flip)).reason).toContain("2.11.0")
      }), { allow_direct: true }))

  it.live("direct - decoder", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        yield* f.client.publish(f.subject, "hello world")
        yield* f.client.publish(f.subject, JSON.stringify({ hello: "world" }))
        expect(yield* Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: 1 })).string).toBe(
          "hello world"
        )
        expect(yield* Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: 2 })).json())
          .toEqual({ hello: "world" })
      }), { allow_direct: true }))

  it.live("direct - get", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        yield* f.client.publish(`${f.name}.a.1`, "<payload>")
        yield* f.client.publish(`${f.name}.b.1`, "<payload>")
        // A real timestamp boundary is needed because Date exposes millisecond precision.
        yield* Effect.sleep("2 millis")
        for (let index = 2; index <= 8; index++) {
          yield* f.client.publish(`${f.name}.z.a`, new Uint8Array(15))
          yield* f.client.publish(`${f.name}.a.${index}`, "<payload>")
          yield* f.client.publish(`${f.name}.b.${index}`, "<payload>")
        }
        yield* f.client.publish(`${f.name}.z.a`, new Uint8Array(15))
        expect((yield* f.manager.direct.getMessage(f.name, { seq: 0 }).pipe(Effect.flip)).reason).toMatch(
          /empty request/i
        )
        const first = Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: 1 }))
        expect(first.seq).toBe(1)
        expect(first.subject).toBe(`${f.name}.a.1`)
        const z = Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { next_by_subj: `${f.name}.z.a` }))
        expect(z.seq).toBe(3)
        expect(
          Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: 4, next_by_subj: `${f.name}.z.a` })).seq
        )
          .toBe(6)
        expect(Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { start_time: z.time })).seq).toBe(3)
        expect(Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { last_by_subj: `${f.name}.z.a` })).seq)
          .toBe(24)
      }), { allow_direct: true }))

  it.live("direct - callback", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const callbackFailure = (stream: string) =>
          Effect.gen(function*() {
            const completed = yield* Deferred.make<T.CompletionResult>()
            const messages = yield* f.manager.direct.getBatch(stream, {
              seq: 1,
              callback: (done, message) => {
                expect(Option.isNone(message)).toBe(true)
                return Option.isSome(done) ? Deferred.succeed(completed, done.value).pipe(Effect.asVoid) : undefined
              }
            })
            const terminal = yield* Deferred.await(completed)
            expect(terminal.err).toBeDefined()
            expect(Option.isSome(yield* messages.closed)).toBe(true)
            return terminal.err?.message
          })
        expect(yield* callbackFailure(`${f.name}_MISSING`)).toMatch(/responders/i)
        expect(yield* callbackFailure(f.name)).toMatch(/message not found/i)
        for (const suffix of ["a", "b", "c"]) yield* f.client.publish(`${f.name}.${suffix}`)
        const values: Array<string> = []
        const completed = yield* Deferred.make<T.CompletionResult>()
        const messages = yield* f.manager.direct.getBatch(f.name, {
          seq: 1,
          batch: 10,
          callback: (done, message) => {
            if (Option.isSome(done)) return Deferred.succeed(completed, done.value).pipe(Effect.asVoid)
            values.push(Option.getOrThrow(message).subject)
          }
        })
        expect(yield* Deferred.await(completed)).toEqual({})
        expect(yield* messages.closed).toEqual(Option.none())
        expect(values).toEqual([`${f.name}.a`, `${f.name}.b`, `${f.name}.c`])
        expect(yield* messages.getProcessed).toBe(3)
        expect(yield* messages.getReceived).toBe(3)
        expect(yield* messages.getPending).toBe(0)
        expect((yield* Stream.runDrain(messages.stream).pipe(Effect.flip)).reason).toMatch(/callback/i)
      }), { allow_direct: true }))

  it.live("direct - batch", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const times: Array<Date> = []
        for (let index = 1; index <= 8; index++) {
          yield* f.client.publish(f.subject, new Uint8Array(index))
          times.push(Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: index })).time)
          yield* Effect.sleep("2 millis")
        }
        const sequences = (options: T.DirectBatchOptions) =>
          f.manager.direct.getBatch(f.name, options).pipe(
            Effect.flatMap((messages) => messages.stream.pipe(Stream.map((message) => message.seq), Stream.runCollect))
          )
        // @ts-expect-error Verify JavaScript callers receive a typed protocol error for missing start options.
        expect((yield* sequences({ batch: 3 }).pipe(Effect.flip)).reason).toMatch(/empty request/i)
        expect(yield* sequences({ seq: 3, batch: 3 })).toEqual([3, 4, 5])
        // @ts-expect-error Runtime mutually exclusive start options must fail before subscription acquisition.
        expect((yield* sequences({ seq: 100, start_time: times[2] }).pipe(Effect.flip)).reason).toMatch(/exclusive/i)
        expect(yield* sequences({ start_time: times[2], batch: 10 })).toEqual([3, 4, 5, 6, 7, 8])
        expect(yield* sequences({ seq: 1, max_bytes: 4 })).toEqual([1])
      }), { allow_direct: true }))

  it.live("direct - last message for", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        for (const suffix of ["a", "a", "a", "b"]) yield* f.client.publish(`${f.name}.${suffix}`)
        yield* Effect.sleep("2 millis")
        yield* f.client.publish(`${f.name}.b`)
        yield* f.client.publish(`${f.name}.z`)
        const sequences = (options: T.DirectLastFor) =>
          f.manager.direct.getLastMessagesFor(f.name, options).pipe(
            Effect.flatMap((messages) => messages.stream.pipe(Stream.map((message) => message.seq), Stream.runCollect))
          )
        expect(yield* sequences({ multi_last: [`${f.name}.missing`] })).toEqual([])
        expect(yield* sequences({ multi_last: [`${f.name}.a`] })).toEqual([3])
        const multi_last = ["a", "b", "z"].map((suffix) => `${f.name}.${suffix}`)
        expect(yield* sequences({ multi_last })).toEqual([3, 5, 6])
        const fifth = Option.getOrThrow(yield* f.manager.direct.getMessage(f.name, { seq: 5 }))
        expect(yield* sequences({ multi_last, up_to_time: fifth.time })).toEqual([3, 4])
        expect(yield* sequences({ multi_last, up_to_seq: 4 })).toEqual([3, 4])
      }), { allow_direct: true }))

  it.live("direct - batch next_by_subj", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        for (let index = 0; index < 50; index++) {
          yield* f.client.publish(`${f.name}.a`)
          yield* f.client.publish(`${f.name}.b`)
        }
        const first = yield* f.manager.direct.getBatch(f.name, { seq: 0, batch: 100, next_by_subj: `${f.name}.a` })
        const a = yield* Stream.runCollect(first.stream)
        expect(a).toHaveLength(50)
        expect(a.every((message) => message.subject === `${f.name}.a`)).toBe(true)
        const second = yield* f.manager.direct.getBatch(f.name, { seq: 50, batch: 100, next_by_subj: `${f.name}.b` })
        const b = yield* Stream.runCollect(second.stream)
        expect(b).toHaveLength(26)
        expect(b.every((message) => message.subject === `${f.name}.b`)).toBe(true)
      }), { allow_direct: true }))

  it.live("direct - batch no messages", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        const messages = yield* f.manager.direct.getLastMessagesFor(f.name, { multi_last: [`${f.name}.>`], batch: 100 })
        expect(yield* Stream.runCollect(messages.stream)).toEqual([])
        expect(yield* messages.getProcessed).toBe(0)
        expect(yield* messages.getReceived).toBe(0)
        expect(yield* messages.getPending).toBe(0)
        expect(yield* messages.closed).toEqual(Option.none())
      }), { allow_direct: true }))

  it.live("direct - get no messages", () =>
    fixture(0, (f) =>
      Effect.gen(function*() {
        expect(yield* f.manager.direct.getMessage(f.name, { last_by_subj: f.subject })).toEqual(Option.none())
      }), { allow_direct: true }))
})
