import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue, Schedule, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import type * as JetStreamConsumer from "../src/JetStreamConsumer.ts"
import type * as JetStreamManager from "../src/JetStreamManager.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { AckPolicy, DeliverPolicy, PriorityPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { MsgHdrsImpl } from "../src/NATSHeaders.ts"
import { makeServer } from "./server.ts"

interface Context {
  readonly connection: NATSConnection.NATSConnection
  readonly client: JetStreamClient.JetStreamClient
  readonly manager: JetStreamManager.JetStreamManager
  readonly name: string
  readonly subject: string
}
const withStream = <A, E, R>(test: (context: Context) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const client = JetStreamClient.make(connection)
    const manager = yield* client.jetstreamManager()
    const name = "LEGACY_" + crypto.randomUUID().replaceAll("-", "")
    const subject = name + ".a"
    yield* manager.streams.add({ name, subjects: [name + ".>"], storage: StorageType.Memory })
    return yield* test({ connection, client, manager, name, subject }).pipe(
      Effect.ensuring(manager.streams.delete(name).pipe(Effect.asVoid, Effect.orDie))
    )
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode()))
const push = ({ connection, manager, name }: Context, config: Partial<T.ConsumerConfig> = {}) =>
  Effect.gen(function*() {
    const deliver_subject = yield* connection.createInbox
    return yield* manager.consumers.add(name, { ack_policy: AckPolicy.Explicit, deliver_subject, ...config })
  })
const publish = ({ client, subject }: Context, count: number) =>
  Effect.forEach(Array.from({ length: count }), (_, index) => client.publish(subject, `${index + 1}`), {
    discard: true
  })
const notification = (messages: JetStreamConsumer.ConsumerMessages, type: T.ConsumerNotification["type"]) =>
  messages.status.pipe(
    Effect.flatMap((status) =>
      status.pipe(Stream.filter((event) => event.type === type), Stream.take(1), Stream.runCollect)
    ),
    Effect.map((events) => events[0])
  )
const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }))

describe("Exact upstream pull and push consumer laws", { concurrent: false }, () => {
  it.live(
    "blocked push callback keeps the flow control reader responsive",
    () =>
      withStream((context) =>
        Effect.gen(function*() {
          const { client, connection, name } = context
          const created = yield* push(context, {
            durable_name: "callback_controls",
            flow_control: true,
            idle_heartbeat: 100_000_000
          })
          const consumer = yield* client.consumers.getPushConsumer(name, created.name)
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const messages = yield* consumer.consume({
            callback: (message) =>
              Deferred.succeed(started, undefined)
                .pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(message.ackAck()), Effect.asVoid)
          })
          yield* client.publish(context.subject, "one")
          yield* Deferred.await(started)
          const reply = yield* connection.createInbox
          const control = yield* connection.subscribe(reply, { max: 1 })
          const received = yield* control.stream.pipe(Stream.runHead, Effect.forkScoped)
          yield* connection.flush
          yield* connection.publish(created.config.deliver_subject ?? "", undefined, {
            reply,
            headers: new MsgHdrsImpl(100, "FlowControl Request")
          })
          expect(Option.isSome(yield* Fiber.join(received).pipe(Effect.timeout("1 second")))).toBe(true)
          expect(yield* Deferred.isDone(release)).toBe(false)
          yield* Deferred.succeed(release, undefined)
          yield* ready(
            messages.getProcessed.pipe(
              Effect.flatMap((count) => count === 1 ? Effect.void : Effect.fail(new Error("Callback not processed")))
            )
          )
          yield* messages.close
          yield* messages.closed
        })
      ),
    { timeout: 5000 }
  )

  it.live(
    "jetstream - pinned client slow iterator preserves application demand",
    () =>
      withStream((context) =>
        Effect.gen(function*() {
          const { manager, client, name } = context
          yield* publish(context, 100)
          yield* manager.consumers.add(name, {
            durable_name: "a",
            ack_policy: AckPolicy.Explicit,
            priority_groups: ["pinned"],
            priority_timeout: 5_000_000_000,
            priority_policy: PriorityPolicy.PinnedClient
          })
          const a = yield* client.consumers.get(name, "a")
          const iterA = yield* a.consume({ group: "pinned", max_messages: 1, expires: 5000 })
          const statusesA = yield* iterA.status.pipe(
            Effect.flatMap((status) =>
              status.pipe(
                Stream.filter((event) => event.type === "consumer_unpinned"),
                Stream.runCollect
              )
            ),
            Effect.forkScoped
          )
          const first = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const readingA = yield* iterA.stream.pipe(
            Stream.runForEach((message) =>
              Deferred.succeed(first, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(message.ack)
              )
            ),
            Effect.forkScoped
          )
          yield* Deferred.await(first)
          const unpinned = yield* notification(iterA, "consumer_unpinned").pipe(
            Effect.tap(() => iterA.close),
            Effect.forkScoped
          )
          const b = yield* client.consumers.get(name, "a")
          const iterB = yield* b.consume({ group: "pinned", max_messages: 1, expires: 5000 })
          const statusesB = yield* iterB.status.pipe(
            Effect.flatMap((status) =>
              status.pipe(
                Stream.filter((event) => event.type === "consumer_pinned"),
                Stream.runCollect
              )
            ),
            Effect.forkScoped
          )
          const received = yield* iterB.stream.pipe(
            Stream.take(99),
            Stream.tap((message) => message.ackAck()),
            Stream.runCollect
          )
          expect(received.map((message) => message.seq)).toEqual(Array.from({ length: 99 }, (_, index) => index + 2))
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(unpinned))?.type).toBe("consumer_unpinned")
          yield* Fiber.join(readingA)
          expect(yield* iterA.getReceived).toBe(1)
          expect(yield* iterB.getReceived).toBe(99)
          expect(yield* Fiber.join(statusesA)).toHaveLength(1)
          expect(yield* Fiber.join(statusesB)).toHaveLength(1)
        })
      ),
    { timeout: 20_000 }
  )

  it.live.each([false, true])(
    "jetstream - pinned client explicit unpin=%s",
    (explicit) =>
      withStream((context) =>
        Effect.gen(function*() {
          const { manager, client, name } = context
          yield* publish(context, 100)
          yield* manager.consumers.add(name, {
            durable_name: "a",
            ack_policy: AckPolicy.Explicit,
            priority_groups: ["pinned"],
            priority_timeout: (explicit ? 10 : 5) * 1_000_000_000,
            priority_policy: PriorityPolicy.PinnedClient
          })
          const gate = yield* Deferred.make<void>()
          const first = yield* Deferred.make<void>()
          const a = yield* client.consumers.get(name, "a")
          const iterA = yield* a.consume({
            group: "pinned",
            max_messages: 1,
            expires: 5000,
            callback: (message) =>
              Deferred.succeed(first, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(message.ack)
              )
          })
          yield* Deferred.await(first)
          expect((yield* notification(iterA, "consumer_pinned"))?.type).toBe("consumer_pinned")
          const unpinned = yield* notification(iterA, "consumer_unpinned").pipe(Effect.forkScoped)
          const b = yield* client.consumers.get(name, "a")
          const received = yield* Queue.unbounded<number>()
          const holdB = yield* Deferred.make<void>()
          const iterB = yield* b.consume({
            group: "pinned",
            max_messages: 1,
            expires: 5000,
            callback: (message) =>
              message.ack.pipe(
                Effect.andThen(Queue.offer(received, message.seq)),
                Effect.andThen(explicit ? Deferred.await(holdB) : Effect.void)
              )
          })
          const pinnedB = yield* notification(iterB, "consumer_pinned").pipe(Effect.forkScoped)
          if (explicit) yield* manager.consumers.unpin(name, "a", "pinned")
          const count = explicit ? 1 : 99
          const sequences = yield* Effect.forEach(Array.from({ length: count }), () => Queue.take(received))
          expect(sequences).toEqual(Array.from({ length: count }, (_, index) => index + 2))
          expect((yield* Fiber.join(pinnedB))?.type).toBe("consumer_pinned")
          yield* iterB.close
          yield* Deferred.succeed(gate, undefined)
          expect((yield* Fiber.join(unpinned))?.type).toBe("consumer_unpinned")
          yield* iterA.close
          expect(yield* iterA.getReceived).toBe(1)
          expect(yield* iterB.getReceived).toBe(count)
        })
      ),
    { timeout: 20_000 }
  )

  it.live("jetstream - pull consumer options", () =>
    withStream(({ manager, name }) =>
      Effect.gen(function*() {
        const info = yield* manager.consumers.add(name, {
          durable_name: "me",
          ack_policy: AckPolicy.Explicit,
          max_batch: 10,
          max_expires: 20_000_000_000
        })
        expect(info.config).toMatchObject({ max_batch: 10, max_expires: 20_000_000_000 })
      })
    ))

  it.live("jetstream - last of", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { manager, client, name } = context
        for (const suffix of ["A", "B", "B", "A"]) yield* client.publish(name + "." + suffix)
        yield* manager.consumers.add(name, {
          durable_name: "B",
          filter_subject: name + ".B",
          deliver_policy: DeliverPolicy.Last,
          ack_policy: AckPolicy.Explicit
        })
        const consumer = yield* client.consumers.get(name, "B")
        expect(Option.getOrThrow(yield* consumer.next()).seq).toBe(3)
      })
    ))

  it.live.each(["expires", "batch"] as const)(
    "409 - max %s retries continuously",
    (mode) =>
      withStream((context) =>
        Effect.gen(function*() {
          const { manager, client, name } = context
          yield* manager.consumers.add(name, {
            durable_name: "a",
            ack_policy: AckPolicy.Explicit,
            ...(mode === "expires" ? { max_expires: 1_000_000_000 } : { max_batch: 10 })
          })
          const consumer = yield* client.consumers.get(name, "a")
          const options = mode === "expires" ? { expires: 30_000 } : { max_messages: 100, expires: 1000 }
          if (mode === "expires") {
            expect((yield* consumer.next(options).pipe(Effect.flip)).reason).toMatch(/exceeded maxrequestexpires/i)
          }
          const finite = yield* consumer.fetch(options)
          expect((yield* Stream.runCollect(finite.stream).pipe(Effect.flip)).reason).toMatch(
            mode === "expires" ? /exceeded maxrequestexpires/i : /exceeded maxrequestbatch/i
          )
          const iterator = yield* consumer.consume({ ...options, expires: 2000, callback: () => undefined })
          const events = yield* iterator.status.pipe(Effect.flatMap((status) =>
            status.pipe(
              Stream.filter((event) => event.type === "exceeded_limits"),
              Stream.take(2),
              Stream.runCollect
            )
          ))
          expect(events).toHaveLength(2)
          yield* iterator.close
        })
      ),
    { timeout: 15_000 }
  )

  it.live("409 - max message size", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { manager, client, name, subject } = context
        yield* client.publish(subject, new Uint8Array(1024))
        yield* manager.consumers.add(name, { durable_name: "a", ack_policy: AckPolicy.Explicit })
        const consumer = yield* client.consumers.get(name, "a")
        const finite = yield* consumer.fetch({ max_bytes: 10, expires: 1000 })
        const observing = yield* notification(finite, "discard").pipe(Effect.forkChild)
        expect((yield* Stream.runCollect(finite.stream).pipe(Effect.flip)).reason).toMatch(
          /message size exceeds maxbytes/i
        )
        const discard = yield* Fiber.join(observing)
        expect(discard).toMatchObject({ bytesLeft: 10 })
        const iterator = yield* consumer.consume({ max_bytes: 10, expires: 1000, callback: () => undefined })
        expect(yield* notification(iterator, "heartbeats_missed")).toMatchObject({ type: "heartbeats_missed" })
        yield* iterator.close
      })
    ), { timeout: 10_000 })

  it.live.each(["overflow", "prioritized"] as const)(
    "jetstream - priority group %s",
    (policy) =>
      withStream((context) =>
        Effect.gen(function*() {
          const { manager, client, connection, name } = context
          yield* publish(context, 100)
          yield* manager.consumers.add(name, {
            durable_name: "a",
            ack_policy: AckPolicy.Explicit,
            priority_groups: [policy],
            priority_policy: policy === "overflow" ? PriorityPolicy.Overflow : PriorityPolicy.Prioritized
          })
          const sets = policy === "overflow" ?
            [{ min_ack_pending: 2 }, { min_pending: 10 }, { min_pending: 10, min_ack_pending: 100 }] :
            [{ priority: 1 }, { priority: 8 }, { priority: 5 }]
          for (const kind of ["consume", "fetch", "next"] as const) {
            for (const options of sets) {
              const requests = yield* connection.subscribe(`$JS.API.CONSUMER.MSG.NEXT.${name}.a`, { max: 1 })
              const reading = yield* requests.stream.pipe(Stream.runCollect, Effect.forkChild)
              const consumer = yield* client.consumers.get(name, "a")
              const operation = { ...options, group: policy, max_messages: 2, expires: 1000 }
              if (kind === "next") yield* consumer.next(operation)
              else {
                const messages = yield* consumer[kind](operation)
                if (kind === "fetch") yield* messages.stream.pipe(Stream.runForEach((message) => message.ack))
                else {
                  yield* Fiber.join(reading)
                  yield* messages.close
                }
              }
              const sent = (yield* Fiber.join(reading))[0]
              const body = yield* sent.json<unknown>()
              expect(body).toMatchObject({ group: policy, ...options })
            }
          }
        })
      ),
    { timeout: 30_000 }
  )

  it.live("jetstream - durable", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        yield* publish(context, 1)
        yield* push(context, { durable_name: "me" })
        const consumer = yield* client.consumers.getPushConsumer(name, "me")
        const iterator = yield* consumer.consume()
        const messages = yield* iterator.stream.pipe(Stream.take(1), Stream.runCollect)
        yield* messages[0].ackAck()
        expect((yield* consumer.info()).name).toBe("me")
        expect(yield* consumer.delete).toBe(true)
        expect((yield* consumer.info().pipe(Effect.flip)).reason).toMatch(/consumer not found/)
      })
    ))

  it.live("jetstream - queue error checks", () =>
    withStream(({ manager, name }) =>
      Effect.gen(function*() {
        for (const limits of [{ idle_heartbeat: 1_000_000_000 }, { flow_control: true }]) {
          const error = yield* manager.consumers.add(name, {
            durable_name: "me",
            deliver_subject: "x",
            deliver_group: "x",
            ...limits
          }).pipe(Effect.flip)
          expect(error.reason).toMatch(/mutually exclusive/)
        }
      })
    ))

  it.live("jetstream - max ack pending", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { manager, client, name } = context
        yield* publish(context, 10)
        const listed = yield* manager.consumers.list(name)
        expect(yield* listed.next()).toEqual([])
        const info = yield* push(context, { max_ack_pending: 2 })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        const messages = yield* iterator.stream.pipe(
          Stream.take(10),
          Stream.mapEffect((message) =>
            Effect.gen(function*() {
              expect(yield* iterator.getPending).toBeLessThan(3)
              yield* message.ackAck()
              return message.seq
            })
          ),
          Stream.runCollect
        )
        expect(messages).toHaveLength(10)
      })
    ))

  it.live.each([
    { label: "new", policy: DeliverPolicy.New, expected: 6 },
    { label: "last", policy: DeliverPolicy.Last, expected: 5 },
    { label: "seq", policy: DeliverPolicy.StartSequence, expected: 2 }
  ])("jetstream - deliver $label", (options) =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name, subject } = context
        yield* publish(context, 5)
        const info = yield* push(context, {
          deliver_policy: options.policy,
          ...(options.policy === DeliverPolicy.StartSequence ? { opt_start_seq: 2 } : {})
        })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        const reading = yield* iterator.stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        if (options.policy === DeliverPolicy.New) yield* client.publish(subject)
        expect((yield* Fiber.join(reading))[0].seq).toBe(options.expected)
      })
    ))

  it.live("jetstream - deliver start time", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { manager, client, name } = context
        yield* publish(context, 3)
        const third = Option.getOrThrow(yield* manager.streams.getMessage(name, { seq: 3 }))
        const info = yield* push(context, {
          deliver_policy: DeliverPolicy.StartTime,
          opt_start_time: third.timestamp
        })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        expect((yield* iterator.stream.pipe(Stream.take(1), Stream.runCollect))[0].seq).toBe(3)
      })
    ))

  it.live("jetstream - deliver last per subject", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        for (const suffix of ["A", "B", "A", "B", "A", "B"]) yield* client.publish(name + "." + suffix)
        const info = yield* push(context, { deliver_policy: DeliverPolicy.LastPerSubject, filter_subject: ">" })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        expect((yield* iterator.stream.pipe(Stream.take(2), Stream.runCollect)).map((message) => message.seq)).toEqual([
          5,
          6
        ])
        expect((yield* consumer.info()).num_ack_pending).toBe(2)
      })
    ))

  it.live("jetstream - ack lease extends with working", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name, connection } = context
        yield* publish(context, 1)
        const info = yield* push(context, { durable_name: "me", ack_wait: 2_000_000_000 })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        const message = (yield* iterator.stream.pipe(Stream.take(1), Stream.runCollect))[0]
        yield* message.working
        expect((yield* consumer.info()).num_ack_pending).toBe(1)
        yield* message.ackAck()
        yield* connection.flush
        expect(yield* consumer.info()).toMatchObject({
          delivered: { stream_seq: 1 },
          num_redelivered: 0,
          num_ack_pending: 0
        })
      })
    ))

  it.live("jetstream - idle heartbeats", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        yield* publish(context, 1)
        yield* push(context, { durable_name: "me", idle_heartbeat: 100_000_000 })
        const consumer = yield* client.consumers.getPushConsumer(name, "me")
        const iterator = yield* consumer.consume({ callback: () => undefined })
        expect(yield* notification(iterator, "heartbeat")).toMatchObject({
          lastConsumerSequence: 1,
          lastStreamSequence: 1
        })
        yield* iterator.close
      })
    ))

  it.live("jetstream - push consumer is bound", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        yield* push(context, { durable_name: "me", deliver_subject: "here" })
        const consumer = yield* client.consumers.getPushConsumer(name, "me")
        const iterator = yield* consumer.consume({ callback: (message) => message.ack })
        expect((yield* consumer.consume().pipe(Effect.flip)).reason).toMatch(/already started/)
        yield* iterator.close
        const restarted = yield* consumer.consume({ callback: (message) => message.ack })
        const other = yield* client.consumers.getPushConsumer(name, "me")
        expect((yield* other.consume().pipe(Effect.flip)).reason).toMatch(/already bound/)
        yield* restarted.close
      })
    ))

  it.live(
    "jetstream - idleheartbeats notifications don't cancel",
    () =>
      withStream(({ client }) =>
        Effect.gen(function*() {
          const consumer = yield* client.consumers.getBoundPushConsumer({
            deliver_subject: "foo",
            idle_heartbeat: 100_000_000
          })
          const iterator = yield* consumer.consume({ callback: () => undefined })
          const events = yield* iterator.status.pipe(Effect.flatMap((status) =>
            status.pipe(
              Stream.filter((event) => event.type === "heartbeats_missed"),
              Stream.take(4),
              Stream.runCollect
            )
          ))
          expect(events).toHaveLength(4)
          yield* iterator.close
          yield* iterator.closed
        })
      ),
    { timeout: 5000 }
  )

  it.live("jetstream - push sync", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        yield* push(context, { durable_name: "me", deliver_subject: "here" })
        yield* publish(context, 2)
        const consumer = yield* client.consumers.getPushConsumer(name, "me")
        const iterator = yield* consumer.consume()
        const pull = yield* Stream.toPull(iterator.stream)
        const sequences: Array<number> = []
        while (sequences.length < 2) {
          for (const message of yield* pull) sequences.push(message.seq)
        }
        expect(sequences).toEqual([1, 2])
      })
    ))

  it.live("jetstream - ordered push consumer honors inbox prefix", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        config:
          "authorization { users: [{user:\"a\",password:\"a\",permissions:{subscribe:{allow:[\"my_inbox_prefix.>\",\"another.>\"]},publish:{allow:[\">\"]}}}] }"
      })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const client = JetStreamClient.make(connection)
        const manager = yield* client.jetstreamManager()
        yield* manager.streams.add({ name: "PREFIX", subjects: ["PREFIX"] })
        yield* client.publish("PREFIX", "hello")
        for (const prefix of [undefined, "another"]) {
          const consumer = yield* client.consumers.getPushConsumer("PREFIX", prefix ? { deliver_prefix: prefix } : {})
          expect((yield* consumer.info()).config.deliver_subject).toMatch(prefix ? /^another\./ : /^my_inbox_prefix\./)
          const iterator = yield* consumer.consume()
          expect((yield* iterator.stream.pipe(Stream.take(1), Stream.runCollect))[0].string()).toBe("hello")
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          user: "a",
          pass: "a",
          inboxPrefix: "my_inbox_prefix"
        }))
      )
    }).pipe(Effect.scoped))

  it.live("jetstream - push consumer doesn't support priority groups", () =>
    withStream(({ manager, name }) =>
      Effect.gen(function*() {
        const error = yield* manager.consumers.add(name, {
          ack_policy: AckPolicy.None,
          deliver_subject: "foo",
          priority_groups: ["hello"],
          priority_policy: PriorityPolicy.Overflow
        }).pipe(Effect.flip)
        expect(error.reason).toMatch(/priority groups.*push consumers/i)
      })
    ))

  it.live("jetstream - push stalled", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, connection, name } = context
        yield* push(context, { durable_name: "dur", deliver_subject: "bar" })
        const consumer = yield* client.consumers.getPushConsumer(name, "dur")
        yield* consumer.consume({ callback: () => undefined })
        const responses = yield* connection.subscribe("here", { max: 1 })
        yield* connection.flush
        const headers = new MsgHdrsImpl(100, "idle heartbeat")
        headers.set("Nats-Consumer-Stalled", "here")
        headers.set("Nats-Last-Stream", "0")
        headers.set("Nats-Last-Consumer", "0")
        yield* connection.publish("bar", undefined, { headers })
        expect(yield* Stream.runCollect(responses.stream)).toHaveLength(1)
      })
    ))

  it.live.each([false, true])("jetstream - cross account push=%s", (isPush) =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        config: `
      accounts {
        JS { jetstream:enabled, users:[{user:js,password:js}], exports:[
          {service:"$JS.API.>",response_type:stream},
          {service:"$JS.ACK.>",response_type:stream}, {stream:"A.>",accounts:[A]}
        ]}
        A { users:[{user:a,password:s3cret}], imports:[
          {service:{subject:"$JS.API.>",account:JS},to:"IPA.>"},
          {service:{subject:"$JS.ACK.>",account:JS}}, {stream:{subject:"A.>",account:JS}}
        ]}
      }`
      })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const client = JetStreamClient.make(connection)
        const manager = yield* client.jetstreamManager()
        yield* manager.streams.add({ name: "ACCOUNT", subjects: ["ACCOUNT"] })
        yield* client.publish("ACCOUNT")
        yield* client.publish("ACCOUNT")
        if (!isPush) yield* manager.consumers.add("ACCOUNT", { durable_name: "me", ack_policy: AckPolicy.None })
        yield* Effect.gen(function*() {
          const imported = yield* NATSConnection.NATSConnection
          const js = JetStreamClient.make(imported, { apiPrefix: "IPA" })
          if (isPush) {
            const jsm = yield* js.jetstreamManager()
            yield* jsm.consumers.add("ACCOUNT", {
              durable_name: "me",
              ack_policy: AckPolicy.Explicit,
              deliver_subject: "A.deliver"
            })
            const consumer = yield* js.consumers.getPushConsumer("ACCOUNT", "me")
            const iterator = yield* consumer.consume()
            const messages = yield* iterator.stream.pipe(Stream.take(2), Stream.runCollect)
            for (const message of messages) yield* message.ackAck()
            expect(yield* consumer.info()).toMatchObject({
              num_pending: 0,
              delivered: { stream_seq: 2 },
              ack_floor: { stream_seq: 2 }
            })
            yield* consumer.delete
            expect((yield* consumer.info().pipe(Effect.flip)).reason).toMatch(/consumer not found/)
          } else {
            const consumer = yield* js.consumers.get("ACCOUNT", "me")
            expect(Option.getOrThrow(yield* consumer.next()).seq).toBe(1)
            expect(Option.getOrThrow(yield* consumer.next()).seq).toBe(2)
            expect(yield* consumer.next({ expires: 1000 })).toEqual(Option.none())
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(NATSConnection.layerNode({
            servers: server.url,
            user: "a",
            pass: "s3cret",
            inboxPrefix: "A"
          }))
        )
      }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "js", pass: "js" })))
    }).pipe(Effect.scoped), { timeout: 10_000 })

  it.live.each([false, true])(
    "jetstream - bound delivery example=%s",
    (example) =>
      withStream((context) =>
        Effect.gen(function*() {
          const { client, name } = context
          const info = yield* push(context, { durable_name: "me", idle_heartbeat: 100_000_000, flow_control: true })
          const consumer = yield* client.consumers.getBoundPushConsumer({
            deliver_subject: info.config.deliver_subject ?? "",
            idle_heartbeat: 100_000_000
          })
          expect((yield* consumer.info().pipe(Effect.flip)).reason).toMatch(/bound.*info/i)
          expect((yield* consumer.delete.pipe(Effect.flip)).reason).toMatch(/bound.*delete/i)
          const iterator = yield* consumer.consume()
          const messages = yield* Queue.unbounded<number>()
          const reading = yield* iterator.stream.pipe(
            Stream.runForEach((message) => message.ackAck().pipe(Effect.andThen(Queue.offer(messages, message.seq)))),
            Effect.forkChild
          )
          for (let index = 0; index < 100; index++) {
            yield* client.publish(name + "." + index, example ? `${index}` : new Uint8Array(100 * 1024))
          }
          const sequences = yield* Effect.forEach(Array.from({ length: 100 }), () => Queue.take(messages))
          expect(sequences).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
          if (!example) {
            expect(yield* notification(iterator, "flow_control")).toMatchObject({ type: "flow_control" })
            expect(yield* notification(iterator, "heartbeat")).toMatchObject({ type: "heartbeat" })
          }
          yield* ready(
            iterator.getProcessed.pipe(
              Effect.flatMap((count) => count === 100 ? Effect.void : Effect.fail(new Error("Processing not complete")))
            )
          )
          expect(yield* iterator.getProcessed).toBe(100)
          yield* iterator.close
          yield* Fiber.join(reading)
        })
      ),
    { timeout: 15_000 }
  )

  it.live("jetstream - flow control", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, connection, name, subject } = context
        const payload = new Uint8Array(100 * 1024)
        for (let block = 0; block < 20; block++) {
          yield* Effect.forEach(Array.from({ length: 100 }), () => client.publish(subject, payload), {
            concurrency: 10
          })
          for (let index = 0; index < 100; index++) yield* connection.publish(subject, payload)
        }
        yield* connection.flush
        const info = yield* push(context, { durable_name: "me", flow_control: true, idle_heartbeat: 5_000_000_000 })
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume({ callback: () => undefined })
        expect(yield* notification(iterator, "flow_control")).toMatchObject({ type: "flow_control" })
        yield* iterator.close
      })
    ), { timeout: 60_000 })

  it.live.each([false, true])("jetstream - push restart durable=%s", (durableResume) =>
    Effect.gen(function*() {
      const server = yield* makeServer()
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const client = JetStreamClient.make(connection)
        const manager = yield* client.jetstreamManager()
        yield* manager.streams.add({ name: "RESTART", subjects: ["test"] })
        yield* manager.consumers.add("RESTART", {
          durable_name: "me",
          ack_policy: AckPolicy.Explicit,
          deliver_subject: "bar"
        })
        const consumer = yield* client.consumers.getPushConsumer("RESTART", "me")
        const delivered = yield* Queue.unbounded<number>()
        const iterator = yield* consumer.consume({
          callback: (message) =>
            message.ackAck().pipe(Effect.andThen(Queue.offer(delivered, message.seq)), Effect.asVoid)
        })
        if (durableResume) {
          for (let index = 0; index < 3; index++) yield* client.publish("test")
          for (let index = 0; index < 3; index++) expect(yield* Queue.take(delivered)).toBe(index + 1)
        }
        const states = connection.changes
        const disconnected = yield* states.pipe(
          Stream.filter((state) => state.state === "Reconnecting"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* server.stop
        yield* Fiber.join(disconnected)
        const reconnected = yield* states.pipe(
          Stream.filter((state) => state.state === "Connected"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* server.start
        yield* Fiber.join(reconnected)
        expect(yield* connection.isClosed).toBe(false)
        for (let index = 0; index < (durableResume ? 3 : 1); index++) yield* client.publish("test")
        for (let index = 0; index < (durableResume ? 3 : 1); index++) {
          expect(yield* Queue.take(delivered)).toBe((durableResume ? 4 : 1) + index)
        }
        expect((yield* consumer.info()).num_pending).toBe(0)
        if (durableResume) expect((yield* manager.streams.info("RESTART")).state.messages).toBe(6)
        yield* iterator.close
      }).pipe(
        Effect.scoped,
        Effect.provide(NATSConnection.layerNode({
          servers: server.url,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 25,
          reconnectJitter: 0
        }))
      )
    }).pipe(Effect.scoped), { timeout: 15_000 })

  it.live("jetstream - nak delay", () =>
    withStream((context) =>
      Effect.gen(function*() {
        const { client, name } = context
        yield* publish(context, 1)
        const info = yield* push(context)
        const consumer = yield* client.consumers.getPushConsumer(name, info.name)
        const iterator = yield* consumer.consume()
        const received = yield* Queue.unbounded<{ seq: number; redelivered: boolean; time: number }>()
        const reading = yield* iterator.stream.pipe(
          Stream.take(2),
          Stream.runForEach((message) =>
            Effect.gen(function*() {
              const time = Date.now()
              yield* Queue.offer(received, { seq: message.seq, redelivered: message.redelivered, time })
              if (message.redelivered) yield* message.ackAck()
              else yield* message.nak(2000)
            })
          ),
          Effect.forkChild
        )
        const first = yield* Queue.take(received)
        const second = yield* Queue.take(received)
        expect(first).toMatchObject({ seq: 1, redelivered: false })
        expect(second).toMatchObject({ seq: 1, redelivered: true })
        expect(second.time - first.time).toBeGreaterThanOrEqual(1800)
        expect(second.time - first.time).toBeLessThanOrEqual(2200)
        yield* Fiber.join(reading)
      })
    ), { timeout: 5000 })
})
