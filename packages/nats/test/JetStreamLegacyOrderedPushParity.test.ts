import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import { AckPolicy, DeliverPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import type * as NATSSubscription from "../src/NATSSubscription.ts"

const fixture = <A, E, R>(
  test: (
    client: JetStreamClient.JetStreamClient,
    name: string,
    connection: NATSConnection.NATSConnection
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const client = JetStreamClient.make(connection)
    const manager = yield* client.jetstreamManager()
    const name = "ORDERED_PUSH_" + crypto.randomUUID().replaceAll("-", "")
    yield* manager.streams.add({ name, subjects: [name + ".>"], storage: StorageType.Memory })
    return yield* test(client, name, connection).pipe(
      Effect.ensuring(manager.streams.delete(name).pipe(Effect.orDie))
    )
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode()))

describe("Exact upstream ordered push consumer laws", () => {
  it.live("ordered push consumers - get", () =>
    fixture((client, name) =>
      Effect.gen(function*() {
        expect((yield* client.consumers.getPushConsumer(name + "_missing").pipe(Effect.flip)).reason)
          .toMatch(/stream not found/)
        yield* client.publish(name + ".a")
        const consumer = yield* client.consumers.getPushConsumer(name, { name_prefix: "my_ordered" })
        const info = yield* consumer.info()
        expect(info.num_pending).toBe(1)
        expect(info.name).toMatch(/^my_ordered_/)
        expect(info.config).toMatchObject({ ack_policy: AckPolicy.None, max_deliver: 1 })
      })
    ))

  it.live("ordered push consumers - consume", () =>
    fixture((client, name) =>
      Effect.gen(function*() {
        for (const suffix of ["a", "b", "c"]) yield* client.publish(name + "." + suffix)
        const consumer = yield* client.consumers.getPushConsumer(name)
        const messages = yield* consumer.consume()
        const received = yield* messages.stream.pipe(Stream.take(3), Stream.runCollect)
        expect(received.map((message) => message.seq)).toEqual([1, 2, 3])
        expect(received[2].info.pending).toBe(0)
        expect(yield* messages.getProcessed).toBe(3)
        yield* messages.closed
      })
    ))

  it.live("ordered push consumers - filters consume", () =>
    fixture((client, name) =>
      Effect.gen(function*() {
        for (const suffix of ["a", "b", "c"]) yield* client.publish(name + "." + suffix)
        const consumer = yield* client.consumers.getPushConsumer(name, { filter_subjects: [name + ".b"] })
        const messages = yield* consumer.consume()
        const received = yield* messages.stream.pipe(Stream.take(1), Stream.runCollect)
        expect(received.map((message) => message.subject)).toEqual([name + ".b"])
        expect(received[0].info.pending).toBe(0)
        yield* messages.closed
        expect(yield* messages.getProcessed).toBe(1)
      })
    ))

  it.live.each([false, true])(
    "ordered push consumers - delivery policy start sequence=%s",
    (sequence) =>
      fixture((client, name) =>
        Effect.gen(function*() {
          yield* client.publish(name + ".a")
          yield* client.publish(name + (sequence ? ".b" : ".a"))
          const consumer = yield* client.consumers.getPushConsumer(
            name,
            sequence ? { opt_start_seq: 2 } : { deliver_policy: DeliverPolicy.LastPerSubject }
          )
          const messages = yield* consumer.consume()
          const received = Option.getOrThrow(yield* messages.stream.pipe(Stream.runHead))
          expect(received.seq).toBe(2)
          expect(received.subject).toBe(name + (sequence ? ".b" : ".a"))
        })
      )
  )

  it.live("ordered push consumers - sub leak", () =>
    fixture((_client, name, connection) =>
      Effect.gen(function*() {
        const subscriptions: Array<NATSSubscription.NATSSubscription> = []
        const tracked: NATSConnection.NATSConnection = {
          ...connection,
          subscribe: (...args) =>
            connection.subscribe(...args).pipe(Effect.tap((sub) =>
              Effect.sync(() => {
                subscriptions.push(sub)
              })
            ))
        }
        const client = JetStreamClient.make(tracked)
        yield* client.publish(name + ".a")
        yield* client.publish(name + ".b")
        const consumer = yield* client.consumers.getPushConsumer(name)
        yield* Effect.gen(function*() {
          const messages = yield* consumer.consume()
          const received = yield* messages.stream.pipe(Stream.take(2), Stream.runCollect)
          expect(received[1].seq).toBe(2)
          yield* messages.closed
        }).pipe(Effect.scoped)
        yield* connection.flush
        expect(subscriptions.length).toBeGreaterThan(0)
        for (const subscription of subscriptions) expect(yield* subscription.isClosed).toBe(true)
      })
    ))

  it.live("push consumers - flow control", () =>
    fixture((client, name, connection) =>
      Effect.gen(function*() {
        for (const options of [{}, { headers_only: true }]) {
          const consumer = yield* client.consumers.getPushConsumer(name, options)
          const info = yield* consumer.info(true)
          expect(info.config.flow_control).toBe(true)
          expect(info.config.ack_policy).toBe(AckPolicy.None)
        }
        const manager = yield* client.jetstreamManager()
        const info = yield* manager.consumers.add(name, { deliver_subject: name + "_deliver" })
        const ordinary = yield* client.consumers.getPushConsumer(name, info.name)
        const config = (yield* ordinary.info(true)).config
        expect(config.flow_control).toBeUndefined()
        expect(config.idle_heartbeat).toBeUndefined()
        let calls = 0
        const spy = yield* connection.subscribe("$JS.API.CONSUMER.CREATE.>", {
          callback: () =>
            Effect.sync(() => {
              calls++
            })
        })
        yield* connection.flush
        yield* client.consumers.getBoundPushConsumer({ deliver_subject: name + "_deliver" })
        yield* connection.flush
        expect(calls).toBe(0)
        yield* spy.unsubscribe()
      })
    ))

  it.live(
    "ordered push recreates twice after malformed delivery sequence without dropping accepted cursor",
    () =>
      fixture((_client, name, connection) =>
        Effect.gen(function*() {
          const corrupt = new Set([2, 3])
          const tracked: NATSConnection.NATSConnection = {
            ...connection,
            subscribe: (...args) =>
              connection.subscribe(...args).pipe(Effect.map((sub) => ({
                ...sub,
                stream: sub.stream.pipe(Stream.map((message) => {
                  const reply = Option.getOrUndefined(message.reply)
                  if (!reply?.startsWith("$JS.ACK.")) return message
                  const fields = reply.split(".")
                  const sequence = Number(fields[fields.length - 4])
                  if (!corrupt.delete(sequence)) return message
                  fields[fields.length - 3] = String(Number(fields[fields.length - 3]) + 1)
                  return { ...message, reply: Option.some(fields.join(".")) }
                }))
              })))
          }
          const client = JetStreamClient.make(tracked)
          for (const suffix of ["a", "b", "c"]) yield* client.publish(name + "." + suffix)
          const consumer = yield* client.consumers.getPushConsumer(name, {
            name_prefix: "gap_name",
            deliver_prefix: "gap_deliver"
          })
          const initial = yield* consumer.info()
          const messages = yield* consumer.consume()
          const received = yield* messages.stream.pipe(Stream.take(3), Stream.runCollect)
          expect(received.map((message) => message.seq)).toEqual([1, 2, 3])
          const current = yield* consumer.info()
          expect(current.name).not.toBe(initial.name)
          expect(current.name).toMatch(/^gap_name_/)
          expect(current.config.deliver_subject).toMatch(/^gap_deliver\./)
          expect(corrupt.size).toBe(0)
          const events = yield* messages.status.pipe(Effect.flatMap((status) => status.pipe(Stream.runCollect)))
          expect(events.filter((event) => event.type === "ordered_consumer_recreated")).toHaveLength(2)
        })
      ),
    { timeout: 15_000 }
  )
})
