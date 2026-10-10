import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import type * as C from "../src/JetStreamConsumer.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import { AckPolicy, DeliverPolicy, StorageType } from "../src/JetStreamTypes.ts"
import type * as T from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"

const auditedCaseNames: ReadonlyArray<string> = [
  "ordered consumers - get",
  "ordered consumers - fetch",
  "ordered consumers - consume reset [94]",
  "ordered consumers - consume",
  "ordered consumers - filters consume",
  "ordered consumers - filters fetch",
  "ordered consumers - fetch reject consumer type change or concurrency",
  "ordered consumers - consume reject consumer type change or concurrency",
  "ordered consumers - last per subject",
  "ordered consumers - start sequence",
  "ordered consumers - last",
  "ordered consumers - new",
  "ordered consumers - start time",
  "ordered consumers - start time reset",
  "ordered consumers - next",
  "ordered consumers - sub leaks next()",
  "ordered consumers - sub leaks fetch()",
  "ordered consumers - sub leaks consume()",
  "ordered consumers - consume drain",
  "ordered consumers - headers only",
  "ordered consumers - max deliver",
  "ordered consumers - mem",
  "ordered consumers - inboxPrefix is respected",
  "ordered consumers - fetch deleted consumer",
  "ordered consumers - next deleted consumer",
  "ordered consumers - consume stream not found request abort",
  "ordered consumers - consume consumer deleted request abort",
  "ordered consumers - bind is rejected",
  "ordered consumers - name prefix",
  "ordered consumers - fetch reset",
  "ordered consumers - consume reset [918]",
  "ordered consumers - next reset",
  "ordered consumers - no reset on next",
  "ordered consumers - initial creation fails, consumer fails",
  "ordered consumers - stale reference recovers",
  "ordered consumers - consume stale reference recovers",
  "ordered consumer - deliver all policy",
  "ordered - consume stream not found and no responders",
  "ordered - fetch stream not found and no responders",
  "ordered - next stream not found and no responders",
  "push consumers - basics",
  "push consumers - basics cb",
  "push consumers - queue",
  "push consumers - connection status iterator closes",
  "push consumers - connection close closes"
]
const auditedName = (name: string) => {
  if (!auditedCaseNames.includes(name)) throw new Error(`Unmapped parity case: ${name}`)
  return name
}

type Fixture = {
  connection: NATSConnection.NATSConnection
  client: JetStreamClient.JetStreamClient
  manager: JetStreamManager.JetStreamManager
  name: string
  subject: string
  subs: Array<NATSSubscription.NATSSubscription>
  corrupt: (count: number) => void
}
const fixture = <A, E, R>(run: (f: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const native = yield* NATSConnection.NATSConnection
    const subs: Array<NATSSubscription.NATSSubscription> = []
    let faults = 0
    const connection: NATSConnection.NATSConnection = {
      ...native,
      subscribe: (subject, opts) =>
        native.subscribe(subject, opts).pipe(Effect.map((sub) => {
          subs.push(sub)
          return {
            ...sub,
            stream: sub.stream.pipe(Stream.map((message) => {
              if (faults && Option.isSome(message.reply) && message.reply.value.startsWith("$JS.ACK.")) {
                faults--
                const tokens = message.reply.value.split(".")
                tokens[tokens.length - 3] = "999"
                return { ...message, reply: Option.some(tokens.join(".")) }
              }
              return message
            }))
          }
        }))
    }
    const client = JetStreamClient.make(connection)
    const manager = JetStreamManager.make(connection)
    const name = `ORDERED_${crypto.randomUUID().replaceAll("-", "")}`
    const subject = `${name}.a`
    yield* Effect.acquireRelease(
      manager.streams.add({ name, subjects: [`${name}.*`], storage: StorageType.Memory }),
      () =>
        manager.streams.delete(name).pipe(
          Effect.catch((error) =>
            error.apiError?.err_code === 10059 ?
              Effect.void :
              Effect.gen(function*() {
                const cleanup = yield* NATSConnection.NATSConnection
                yield* JetStreamManager.make(cleanup).streams.delete(name)
              }).pipe(Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" })))
          ),
          Effect.orDie
        )
    )
    return yield* run({
      connection,
      client,
      manager,
      name,
      subject,
      subs,
      corrupt: (count) => {
        faults = count
      }
    })
  }).pipe(
    Effect.scoped,
    Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222", inboxPrefix: "orderedInbox" }))
  )
const publish = (f: Fixture, count: number, subjects = false) =>
  Effect.forEach(
    Array.from({ length: count }, (_, i) => i + 1),
    (i) => f.client.publish(subjects ? `${f.name}.${String.fromCharCode(96 + i)}` : f.subject, JSON.stringify(i))
  )
const head = (consumer: C.Consumer) => consumer.next({ expires: 1000 }).pipe(Effect.map(Option.getOrThrow))
const collect = (messages: C.ConsumerMessages, take?: number) =>
  (take === undefined ? messages.stream : messages.stream.pipe(Stream.take(take))).pipe(Stream.runCollect)
const waitAdmitted = (consumer: C.Consumer) =>
  Effect.gen(function*() {
    while ((yield* consumer.info()).num_waiting === 0) yield* Effect.sleep(10)
  }).pipe(Effect.timeout("2 seconds"))
const noSubs = (f: Fixture) =>
  Effect.forEach(
    f.subs,
    (sub) => sub.isClosed.pipe(Effect.tap((closed) => Effect.sync(() => expect(closed).toBe(true))))
  )
const resetEvents = (messages: C.ConsumerMessages, events: Array<T.ConsumerNotification>) =>
  messages.status.pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            events.push(event)
          })
        ),
        Stream.runDrain
      )
    ),
    Effect.forkChild
  )

describe("Official ordered and push consumer cases", () => {
  it.live(auditedName("ordered consumers - get"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        expect((yield* f.client.consumers.get(`${f.name}_missing`).pipe(Effect.flip)).reason).toContain(
          "stream not found"
        )
        yield* publish(f, 1)
        const c = yield* f.client.consumers.get(f.name)
        const info = yield* c.info()
        expect(info.name).toMatch(/^ordered_/)
        expect(info.num_pending).toBe(1)
      })
    ))
  it.live(auditedName("ordered consumers - fetch"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 3, true)
        const c = yield* f.client.consumers.get(f.name)
        for (const seq of [1, 2]) {
          const messages = yield* c.fetch({ max_messages: 1 })
          const values = yield* collect(messages)
          expect(values.map((m) => m.seq)).toEqual([seq])
          expect(values[0].subject).toBe(`${f.name}.${String.fromCharCode(96 + seq)}`)
        }
      })
    ))
  it.live(auditedName("ordered consumers - consume reset [94]"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 3)
        const c = yield* f.client.consumers.get(f.name)
        const initial = (yield* c.info()).name
        f.corrupt(2)
        const messages = yield* c.consume({ max_messages: 1 })
        const events: Array<T.ConsumerNotification> = []
        const watching = yield* resetEvents(messages, events)
        expect((yield* collect(messages, 3)).map((m) => m.seq)).toEqual([1, 2, 3])
        yield* Fiber.join(watching)
        expect(events.filter((event) => event.type === "ordered_consumer_recreated")).toHaveLength(2)
        expect((yield* c.info()).name).not.toBe(initial)
      })
    ))
  it.live(auditedName("ordered consumers - consume"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 3)
        const c = yield* f.client.consumers.get(f.name)
        const messages = yield* c.consume({ max_messages: 1 })
        const values = yield* collect(messages, 3)
        expect(values.map((m) => m.seq)).toEqual([1, 2, 3])
        expect(values[2].info.pending).toBe(0)
      })
    ))
  for (const mode of ["consume", "fetch"] as const) {
    it.live(auditedName(`ordered consumers - filters ${mode}`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          yield* publish(f, 3, true)
          const c = yield* f.client.consumers.get(f.name, { filter_subjects: [`${f.name}.b`] })
          const messages = yield* c[mode]({ expires: 1000 })
          expect((yield* collect(messages, mode === "consume" ? 1 : undefined)).map((m) => m.subject)).toEqual([
            `${f.name}.b`
          ])
          expect(yield* messages.getProcessed).toBe(1)
        })
      ))
    it.live(
      auditedName(`ordered consumers - ${mode} reject consumer type change or concurrency`),
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            const c = yield* f.client.consumers.get(f.name)
            const messages = yield* c[mode]({ expires: 1000 })
            expect((yield* c[mode]().pipe(Effect.flip)).reason).toContain(`concurrent ${mode}`)
            yield* messages.close
            expect((yield* c[mode === "consume" ? "fetch" : "consume"]().pipe(Effect.flip)).reason).toContain(
              `initialized as ${mode}`
            )
          })
        )
    )
  }
  for (
    const [name, opts] of [
      ["last per subject", { deliver_policy: DeliverPolicy.LastPerSubject }],
      ["start sequence", { opt_start_seq: 2 }],
      ["last", { deliver_policy: DeliverPolicy.Last }]
    ] as const
  ) {
    it.live(auditedName(`ordered consumers - ${name}`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          yield* publish(f, 2)
          for (const mode of ["fetch", "consume"] as const) {
            const c = yield* f.client.consumers.get(f.name, opts)
            const messages = yield* c[mode]({ max_messages: 1 })
            expect((yield* collect(messages, 1)).map((m) => m.seq)).toEqual([2])
          }
        })
      ))
  }
  for (const name of ["new", "start time", "start time reset"]) {
    it.live(auditedName(`ordered consumers - ${name}`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          yield* publish(f, 2, true)
          yield* Effect.sleep(10)
          const stored = Option.getOrThrow(yield* f.manager.streams.getMessage(f.name, { seq: 2 }))
          const date = new Date(stored.time.getTime() + 1).toISOString()
          yield* Effect.sleep(5)
          const opts = name === "new" ? { deliver_policy: DeliverPolicy.New } : {
            deliver_policy: DeliverPolicy.StartTime,
            opt_start_time: date
          }
          for (const mode of name === "start time reset" ? ["fetch"] as const : ["fetch", "consume"] as const) {
            const c = yield* f.client.consumers.get(f.name, opts)
            const ack = mode === "fetch" || name === "new" ? yield* f.client.publish(`${f.name}.c`, "3") : { seq: 3 }
            const messages = yield* c[mode]({ max_messages: 1 })
            expect((yield* collect(messages, 1))[0].seq).toBe(name === "new" ? ack.seq : 3)
            if (name === "start time reset") {
              f.corrupt(1)
              yield* f.client.publish(`${f.name}.d`, "4")
              expect((yield* head(c)).seq).toBe(4)
              const info = yield* c.info()
              expect(info.config.deliver_policy).toBe(DeliverPolicy.StartSequence)
              expect(info.config.opt_start_seq).toBe(4)
            }
          }
        })
      ))
  }
  it.live(auditedName("ordered consumers - next"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name)
        expect(yield* c.next({ expires: 1000 })).toEqual(Option.none())
        yield* publish(f, 2)
        expect((yield* head(c)).seq).toBe(1)
        expect((yield* head(c)).seq).toBe(2)
      })
    ))
  for (const mode of ["next", "fetch", "consume"] as const) {
    it.live(auditedName(`ordered consumers - sub leaks ${mode}()`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          const c = yield* f.client.consumers.get(f.name)
          if (mode === "next") yield* c.next({ expires: 1000 })
          else {
            const messages = yield* c[mode]({ expires: 1000 })
            const running = yield* collect(messages).pipe(Effect.forkChild)
            if (mode === "consume") {
              yield* f.connection.flush
              yield* messages.close
            }
            yield* Fiber.join(running)
          }
          yield* noSubs(f)
        })
      ))
  }
  it.live(auditedName("ordered consumers - consume drain"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name)
        const messages = yield* c.consume()
        const running = yield* collect(messages).pipe(Effect.exit, Effect.forkChild)
        yield* f.connection.flush
        yield* f.connection.drain.pipe(Effect.timeout("1 second"))
        yield* Fiber.join(running).pipe(Effect.timeout("1 second"))
      })
    ))
  for (
    const [name, opts, field, value] of [
      ["headers only", { headers_only: true }, "headers_only", true],
      ["max deliver", {}, "max_deliver", 1],
      ["mem", {}, "mem_storage", true]
    ] as const
  ) {
    it.live(auditedName(`ordered consumers - ${name}`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          const c = yield* f.client.consumers.get(f.name, opts)
          expect((yield* c.info()).config[field]).toBe(value)
        })
      ))
  }
  it.live(auditedName("ordered consumers - inboxPrefix is respected"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name)
        const messages = yield* c.consume()
        yield* f.connection.flush
        expect(
          (yield* Effect.forEach(f.subs, (sub) => sub.getSubject)).some((subject) =>
            subject.startsWith("orderedInbox.")
          )
        )
          .toBe(true)
        yield* messages.close
      })
    ))
  for (const mode of ["fetch", "next"] as const) {
    it.live(auditedName(`ordered consumers - ${mode} deleted consumer`), () =>
      fixture((f) =>
        Effect.gen(function*() {
          const c = yield* f.client.consumers.get(f.name)
          const pending = mode === "fetch"
            ? c.fetch({ expires: 3000 }).pipe(Effect.flatMap((m) => collect(m)), Effect.asVoid)
            : c.next({ expires: 3000 }).pipe(Effect.asVoid)
          const running = yield* pending.pipe(Effect.flip, Effect.forkChild)
          yield* waitAdmitted(c)
          yield* c.delete
          expect((yield* Fiber.join(running)).reason.toLowerCase()).toContain("consumer deleted")
        })
      ))
  }
  for (const missing of ["stream not found", "consumer deleted"]) {
    it.live(
      auditedName(`ordered consumers - consume ${missing} request abort`),
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            const c = yield* f.client.consumers.get(f.name)
            if (missing === "stream not found") yield* f.manager.streams.delete(f.name)
            const messages = yield* c.consume({ expires: 1000, abort_on_missing_resource: true })
            const running = yield* collect(messages).pipe(Effect.flip, Effect.forkChild)
            if (missing === "consumer deleted") {
              yield* waitAdmitted(c)
              yield* c.delete
            }
            expect((yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))).reason.toLowerCase()).toContain(
              missing
            )
          })
        )
    )
  }
  it.live(auditedName("ordered consumers - bind is rejected"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name)
        for (const mode of ["next", "fetch", "consume"] as const) {
          const operation = mode === "next"
            ? c.next({ bind: true }).pipe(Effect.asVoid)
            : c[mode]({ bind: true }).pipe(Effect.asVoid)
          expect((yield* operation.pipe(Effect.flip)).reason).toContain("'bind' is not supported")
        }
      })
    ))
  it.live(auditedName("ordered consumers - name prefix"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name, { name_prefix: "hello" })
        expect((yield* c.info()).name.startsWith("hello")).toBe(true)
        for (const name_prefix of ["", "one.two"]) {
          expect((yield* f.client.consumers.get(f.name, { name_prefix }).pipe(Effect.flip)).reason).toContain(
            "name_prefix"
          )
        }
      })
    ))
  it.live(auditedName("ordered consumers - fetch reset"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 1)
        const c = yield* f.client.consumers.get(f.name)
        const initial = (yield* c.info()).name
        const first = yield* c.fetch({ max_messages: 10, expires: 1000 })
        const events: Array<T.ConsumerNotification> = []
        const watching = yield* resetEvents(first, events)
        const seqs = (yield* collect(first)).map((m) => m.seq)
        yield* Fiber.join(watching)
        for (let i = 2; i <= 11; i++) yield* f.client.publish(f.subject, JSON.stringify(i))
        const second = yield* c.fetch({ max_messages: 10, expires: 1000 })
        const secondWatching = yield* resetEvents(second, events)
        seqs.push(...(yield* collect(second)).map((m) => m.seq))
        yield* Fiber.join(secondWatching)
        expect(seqs).toEqual(Array.from({ length: 11 }, (_, i) => i + 1))
        expect((yield* c.info()).name).toBe(initial)
        expect(events.filter((e) => e.type === "ordered_consumer_recreated")).toEqual([])
      })
    ))
  it.live(auditedName("ordered consumers - consume reset [918]"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 1)
        const c = yield* f.client.consumers.get(f.name)
        const initial = (yield* c.info()).name
        const messages = yield* c.consume({ max_messages: 11, idle_heartbeat: 1000 })
        const events: Array<T.ConsumerNotification> = []
        const watching = yield* resetEvents(messages, events)
        const values = yield* messages.stream.pipe(
          Stream.tap((m) =>
            m.seq === 1 ?
              Effect.gen(function*() {
                f.corrupt(1)
                for (let i = 2; i < 20; i++) yield* f.client.publish(f.subject, JSON.stringify(i))
              }) :
              Effect.void
          ),
          Stream.take(11),
          Stream.runCollect
        )
        yield* Fiber.join(watching)
        expect(values.map((m) => m.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1))
        expect(events.filter((e) => e.type === "ordered_consumer_recreated")).toHaveLength(1)
        expect((yield* c.info()).name).not.toBe(initial)
      })
    ))
  for (const reset of [true, false]) {
    it.live(
      reset ? "ordered consumers - next reset" : "ordered consumers - no reset on next",
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            yield* publish(f, 2)
            const c = yield* f.client.consumers.get(f.name)
            const initial = (yield* c.info()).name
            expect((yield* head(c)).seq).toBe(1)
            if (reset) f.corrupt(1)
            expect((yield* head(c)).seq).toBe(2)
            expect((yield* c.info()).name === initial).toBe(!reset)
          })
        )
    )
  }
  it.live(
    auditedName("ordered consumers - initial creation fails, consumer fails"),
    () =>
      fixture((f) =>
        Effect.gen(function*() {
          const c = yield* f.client.consumers.get(f.name)
          yield* f.manager.streams.delete(f.name)
          const messages = yield* c.consume({ abort_on_missing_resource: true, idle_heartbeat: 1000 })
          expect((yield* collect(messages).pipe(Effect.flip)).reason).toContain("stream not found")
        })
      )
  )
  it.live(auditedName("ordered consumers - stale reference recovers"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* publish(f, 2)
        const c = yield* f.client.consumers.get(f.name)
        expect(yield* (yield* head(c)).json()).toBe(1)
        yield* c.delete
        expect((yield* c.next({ expires: 1000 }).pipe(Effect.flip)).reason.toLowerCase()).toContain("responders")
        expect(yield* (yield* head(c)).json()).toBe(2)
      })
    ))
  it.live(
    auditedName("ordered consumers - consume stale reference recovers"),
    () =>
      fixture((f) =>
        Effect.gen(function*() {
          yield* publish(f, 1)
          const c = yield* f.client.consumers.get(f.name)
          const initial = (yield* c.info()).name
          yield* c.delete
          const messages = yield* c.consume({ idle_heartbeat: 1000 })
          const events: Array<T.ConsumerNotification> = []
          const watching = yield* resetEvents(messages, events)
          expect(yield* (yield* collect(messages, 1))[0].json()).toBe(1)
          yield* Fiber.join(watching)
          expect((yield* c.info()).name).not.toBe(initial)
          expect(events.filter((e) => e.type === "ordered_consumer_recreated")).toHaveLength(1)
        })
      )
  )
  it.live(auditedName("ordered consumer - deliver all policy"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        const c = yield* f.client.consumers.get(f.name, { deliver_policy: DeliverPolicy.All })
        expect((yield* c.info()).config.deliver_policy).toBe(DeliverPolicy.All)
      })
    ))
  for (const mode of ["consume", "fetch", "next"] as const) {
    it.live(
      auditedName(`ordered - ${mode} stream not found and no responders`),
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            const c = yield* f.client.consumers.get(f.name)
            yield* f.manager.streams.delete(f.name)
            if (mode === "consume") {
              const messages = yield* c.consume({ expires: 1000 })
              const events: Array<T.ConsumerNotification> = []
              const observing = yield* messages.status.pipe(
                Effect.flatMap((s) =>
                  s.pipe(
                    Stream.tap((event) =>
                      Effect.sync(() => {
                        events.push(event)
                      })
                    ),
                    Stream.filter((e) => e.type === "heartbeats_missed" && e.count === 3),
                    Stream.runHead
                  )
                ),
                Effect.forkChild
              )
              const running = yield* collect(messages, 1).pipe(Effect.forkChild)
              yield* Fiber.join(observing).pipe(Effect.timeout("10 seconds"))
              expect(events.some((e) => e.type === "stream_not_found")).toBe(true)
              expect(events.some((e) => e.type === "no_responders")).toBe(true)
              yield* f.manager.streams.add({ name: f.name, subjects: [`${f.name}.*`], storage: StorageType.Memory })
              yield* f.client.publish(f.subject, "recovered")
              expect((yield* Fiber.join(running).pipe(Effect.timeout("5 seconds")))[0].string()).toBe("recovered")
            } else {
              const failed = mode === "next"
                ? c.next({ expires: 1000 }).pipe(Effect.asVoid)
                : c.fetch({ expires: 1000 }).pipe(Effect.flatMap((m) => collect(m)), Effect.asVoid)
              expect((yield* failed.pipe(Effect.flip)).reason.toLowerCase()).toContain("responders")
              yield* f.manager.streams.add({ name: f.name, subjects: [`${f.name}.*`], storage: StorageType.Memory })
              yield* f.client.publish(f.subject, "recovered")
              expect((yield* head(c)).string()).toBe("recovered")
            }
          })
        )
    )
  }

  for (const callback of [false, true]) {
    it.live(
      callback ? "push consumers - basics cb" : "push consumers - basics",
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            yield* publish(f, 3, true)
            yield* f.manager.consumers.add(f.name, {
              durable_name: "push",
              deliver_subject: `DELIVER.${f.name}`,
              deliver_policy: DeliverPolicy.All,
              idle_heartbeat: 5_000_000_000,
              flow_control: true,
              ack_policy: AckPolicy.Explicit
            })
            const c = yield* f.client.consumers.getPushConsumer(f.name, "push")
            expect(yield* c.isPushConsumer).toBe(true)
            expect(yield* c.isPullConsumer).toBe(false)
            expect((yield* c.info(true)).config.deliver_group).toBeUndefined()
            const done = yield* Deferred.make<void>()
            const messages = yield* c.consume(
              callback
                ? {
                  callback: (m) =>
                    m.ackAck().pipe(Effect.andThen(m.seq === 3 ? Deferred.succeed(done, undefined) : Effect.void))
                }
                : {}
            )
            if (callback) {
              yield* Deferred.await(done).pipe(Effect.timeout("3 seconds"))
              yield* messages.close
            } else yield* messages.stream.pipe(Stream.tap((m) => m.ackAck()), Stream.take(3), Stream.runDrain)
            yield* messages.closed
            expect(yield* messages.getProcessed).toBe(3)
            const info = yield* c.info()
            expect(info.num_pending).toBe(0)
            expect(info.delivered.stream_seq).toBe(3)
            expect(info.ack_floor.stream_seq).toBe(3)
          })
        )
    )
  }
  it.live(auditedName("push consumers - queue"), () =>
    fixture((f) =>
      Effect.gen(function*() {
        yield* f.manager.consumers.add(f.name, {
          durable_name: "push",
          deliver_subject: `DELIVER.${f.name}`,
          deliver_group: "q",
          ack_policy: AckPolicy.Explicit
        })
        const c1 = yield* f.client.consumers.getPushConsumer(f.name, "push")
        const c2 = yield* f.client.consumers.getPushConsumer(f.name, "push")
        expect((yield* c1.info(true)).config.deliver_group).toBe("q")
        expect((yield* c2.info(true)).config.deliver_group).toBe("q")
        const m1 = yield* c1.consume()
        const m2 = yield* c2.consume()
        const values: Array<number> = []
        const done = yield* Deferred.make<void>()
        const consume = (m: C.ConsumerMessages) =>
          m.stream.pipe(
            Stream.tap((message) =>
              message.ackAck().pipe(
                Effect.andThen(Effect.sync(() => {
                  values.push(message.seq)
                })),
                Effect.andThen(
                  Effect.suspend(() => values.length === 1000 ? Deferred.succeed(done, undefined) : Effect.void)
                )
              )
            ),
            Stream.runDrain,
            Effect.forkChild
          )
        const r1 = yield* consume(m1)
        const r2 = yield* consume(m2)
        yield* publish(f, 1000)
        yield* Deferred.await(done).pipe(Effect.timeout("15 seconds"))
        yield* m1.close
        yield* m2.close
        yield* Fiber.join(r1)
        yield* Fiber.join(r2)
        expect(yield* m1.getProcessed).toBeGreaterThan(0)
        expect(yield* m2.getProcessed).toBeGreaterThan(0)
        expect(new Set(values).size).toBe(1000)
        const info = yield* c1.info()
        expect(info.delivered.consumer_seq).toBe(1000)
        expect(info.num_pending).toBe(0)
      })
    ))
  for (const shutdown of [false, true]) {
    it.live(
      shutdown ? "push consumers - connection close closes" : "push consumers - connection status iterator closes",
      () =>
        fixture((f) =>
          Effect.gen(function*() {
            yield* f.manager.consumers.add(f.name, {
              durable_name: "push",
              deliver_subject: `DELIVER.${f.name}`,
              idle_heartbeat: 1_000_000_000,
              ack_policy: AckPolicy.Explicit
            })
            const c = yield* f.client.consumers.getPushConsumer(f.name, "push")
            const messages = yield* c.consume({ callback: (m) => m.ack })
            const status = yield* messages.status
            const watching = yield* status.pipe(Stream.runDrain, Effect.forkChild)
            yield* f.connection.flush
            if (shutdown) yield* f.connection.close
            else yield* messages.close
            yield* messages.closed.pipe(Effect.exit, Effect.timeout("1 second"))
            yield* Fiber.join(watching).pipe(Effect.timeout("1 second"))
            yield* noSubs(f)
          })
        )
    )
  }
})
