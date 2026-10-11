import { describe, expect, it } from "@effect/vitest"
import { jetstream as officialJetStream, jetstreamManager as officialManager } from "@nats-io/jetstream"
import { connect as officialConnect } from "@nats-io/transport-node"
import { Deferred, Effect, Fiber, Option, Queue, Schedule, Schema, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSError from "../src/NATSError.ts"
import { headers } from "../src/NATSHeaders.ts"
import { testJetStream } from "./dependencies.ts"

const name = "NATIVE_PARITY_STREAM"
const subject = "native.jetstream.parity"
const stream = Effect.acquireRelease(
  JetStreamManager.JetStreamManager.pipe(Effect.flatMap((manager) =>
    manager.streams.add({
      name,
      subjects: [`${subject}.>`],
      storage: StorageType.Memory,
      retention: RetentionPolicy.Limits,
      allow_direct: true,
      duplicate_window: 60_000_000_000
    })
  )),
  () =>
    JetStreamManager.JetStreamManager.pipe(
      Effect.flatMap((manager) => manager.streams.delete(name)),
      Effect.orDie
    )
)
const official = Effect.acquireRelease(
  Effect.tryPromise({ try: () => officialConnect({ servers: "localhost:4222" }), catch: (cause) => cause }),
  (connection) => Effect.promise(() => connection.close())
)

const withStream = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    yield* stream
    return yield* test
  }).pipe(Effect.scoped, Effect.provide(testJetStream))

describe("JetStream 3.4.0 behavioral parity", { concurrent: false }, () => {
  it.live("native and official publishers agree on stream sequence and deduplication", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const reference = yield* official
        const referenceClient = officialJetStream(reference)
        const first = yield* client.publish(`${subject}.dedup`, "one", { msgID: "same-id" })
        const duplicate = yield* Effect.tryPromise({
          try: () => referenceClient.publish(`${subject}.dedup`, "one", { msgID: "same-id" }),
          catch: (cause) => cause
        })
        const second = yield* Effect.tryPromise({
          try: () => referenceClient.publish(`${subject}.dedup`, "two"),
          catch: (cause) => cause
        })
        const nativeDuplicate = yield* client.publish(`${subject}.dedup`, "one", { msgID: "same-id" })
        expect(first).toMatchObject({ stream: name, seq: 1, duplicate: false })
        expect(duplicate).toMatchObject({ stream: name, seq: 1, duplicate: true })
        expect(second.seq).toBe(2)
        expect(nativeDuplicate).toMatchObject({ stream: name, seq: 1, duplicate: true })
      })
    ))

  it.live.each([
    { label: "stream", expect: { streamName: "WRONG_STREAM" } },
    { label: "last sequence", expect: { lastSequence: 999 } },
    { label: "last subject sequence", expect: { lastSubjectSequence: 999 } },
    { label: "last message ID", expect: { lastMsgID: "missing-id" } }
  ])("rejects conflicting publish expectations: $label", (options) =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        yield* client.publish(`${subject}.expect`, "first", { msgID: "first-id" })
        const error = yield* client.publish(`${subject}.expect`, "conflict", { expect: options.expect }).pipe(
          Effect.flip
        )
        expect(error._tag).toBe("JetStreamClientError")
        const manager = yield* JetStreamManager.JetStreamManager
        expect((yield* manager.streams.info(name)).state.messages).toBe(1)
      })
    ))

  it.live("accepts matching publish expectations", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        yield* client.publish(`${subject}.expect`, "first", { msgID: "first-id" })
        const ack = yield* client.publish(`${subject}.expect`, "second", {
          expect: { streamName: name, lastSequence: 1, lastSubjectSequence: 1, lastMsgID: "first-id" }
        })
        expect(ack.seq).toBe(2)
      })
    ))

  it.live("stored and direct reads preserve binary payloads, subjects, headers and sequence", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        const messageHeaders = headers()
        messageHeaders.append("X-Test", "first")
        messageHeaders.append("X-Test", "second")
        const payload = Uint8Array.of(0, 13, 10, 255)
        yield* client.publish(`${subject}.binary`, payload, { headers: messageHeaders })
        const stored = Option.getOrThrow(yield* manager.streams.getMessage(name, { seq: 1 }))
        const direct = Option.getOrThrow(yield* manager.direct.getMessage(name, { seq: 1 }))
        for (const message of [stored, direct]) {
          expect(message.data).toEqual(payload)
          expect(message.seq).toBe(1)
          expect(message.subject).toBe(`${subject}.binary`)
          expect(message.header.values("X-Test")).toEqual(["first", "second"])
        }
        expect(yield* manager.direct.getMessage(name, { seq: 99 })).toEqual(Option.none())
        expect(yield* manager.streams.getMessage(name, { seq: 99 })).toEqual(Option.none())
      })
    ))

  it.live("filtered purge keeps the requested suffix and leaves other subjects intact", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        for (const suffix of ["a", "b", "a", "b", "a"]) yield* client.publish(`${subject}.${suffix}`, suffix)
        const purge = yield* manager.streams.purge(name, { filter: `${subject}.a`, keep: 1 })
        expect(purge.purged).toBe(2)
        expect((yield* manager.streams.info(name)).state.messages).toBe(3)
        expect(Option.getOrThrow(yield* manager.streams.getMessage(name, { last_by_subj: `${subject}.a` })).seq).toBe(5)
      })
    ))

  it.live("stream updates preserve existing configuration and agree with the official manager", () =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        const updated = yield* manager.streams.update(name, { description: "native update", max_msgs: 2 })
        expect(updated.config.subjects).toEqual([`${subject}.>`])
        expect(updated.config.storage).toBe(StorageType.Memory)
        const reference = yield* official
        const referenceManager = yield* Effect.tryPromise({
          try: () => officialManager(reference),
          catch: (cause) => cause
        })
        const referenceInfo = yield* Effect.tryPromise({
          try: () => referenceManager.streams.info(name),
          catch: (cause) => cause
        })
        expect(referenceInfo.config.description).toBe("native update")
        expect(referenceInfo.config.max_msgs).toBe(2)
        const client = yield* JetStreamClient.JetStreamClient
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.limits`, payload)
        const info = yield* manager.streams.info(name)
        expect(info.state.messages).toBe(2)
        expect(info.state.first_seq).toBe(2)
      })
    ))

  it.live("find, names and list agree on subject filtering", () =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        expect(yield* manager.streams.find(`${subject}.find`)).toBe(name)
        const names = yield* manager.streams.names(`${subject}.find`)
        expect(yield* Stream.runCollect(names.stream)).toEqual([name])
        const streams = yield* manager.streams.list(`${subject}.find`)
        expect((yield* Stream.runCollect(streams.stream)).map((info) => info.config.name)).toEqual([name])
      })
    ))

  it.live("confirmed acknowledgements update consumer ack state", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "ack", ack_policy: AckPolicy.Explicit })
        yield* client.publish(`${subject}.ack`, "hello")
        const consumer = yield* client.consumers.get(name, "ack")
        const message = Option.getOrThrow(yield* consumer.next({ expires: 1000 }))
        expect(message.seq).toBe(1)
        expect(message.info.stream).toBe(name)
        expect(message.info.consumer).toBe("ack")
        expect(message.info.deliveryCount).toBe(1)
        expect(yield* message.ackAck()).toBe(true)
        const info = yield* manager.consumers.info(name, "ack")
        expect(info.num_ack_pending).toBe(0)
        expect(info.ack_floor.stream_seq).toBe(1)
      })
    ))

  it.live.each([DeliverPolicy.New, DeliverPolicy.Last])(
    "respects consumer delivery policy %s",
    (deliverPolicy) =>
      withStream(
        Effect.gen(function*() {
          const client = yield* JetStreamClient.JetStreamClient
          const manager = yield* JetStreamManager.JetStreamManager
          yield* client.publish(`${subject}.policy`, "old-one")
          yield* client.publish(`${subject}.policy`, "old-two")
          yield* manager.consumers.add(name, {
            durable_name: "policy",
            ack_policy: AckPolicy.Explicit,
            deliver_policy: deliverPolicy
          })
          yield* client.publish(`${subject}.policy`, "new")
          const consumer = yield* client.consumers.get(name, "policy")
          const message = Option.getOrThrow(yield* consumer.next({ expires: 1000 }))
          expect(message.string()).toBe(deliverPolicy === DeliverPolicy.New ? "new" : "old-two")
          yield* message.ackAck()
        })
      )
  )

  it.live("consumer updates preserve filters and allow changing acknowledgement limits", () =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, {
          durable_name: "update",
          ack_policy: AckPolicy.Explicit,
          filter_subject: `${subject}.filtered`,
          max_ack_pending: 10
        })
        const updated = yield* manager.consumers.update(name, "update", { max_ack_pending: 20 })
        expect(updated.config.filter_subject).toBe(`${subject}.filtered`)
        expect(updated.config.max_ack_pending).toBe(20)
      })
    ))

  it.live("direct batch reads honor the starting sequence and batch limit", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        for (const payload of ["one", "two", "three", "four"]) yield* client.publish(`${subject}.batch`, payload)
        const batch = yield* manager.direct.getBatch(name, { seq: 2, batch: 2 })
        const messages = yield* Stream.runCollect(batch.stream)
        expect(messages.map((message) => message.seq)).toEqual([2, 3])
        expect(yield* Effect.forEach(messages, (message) => message.string)).toEqual(["two", "three"])
      })
    ))

  it.live("direct last-for reads select the latest message for each subject", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        for (const suffix of ["a", "b", "a", "b"]) yield* client.publish(`${subject}.${suffix}`, suffix)
        const batch = yield* manager.direct.getLastMessagesFor(name, { multi_last: [`${subject}.a`, `${subject}.b`] })
        const messages = yield* Stream.runCollect(batch.stream)
        expect(messages.map((message) => message.seq)).toEqual([3, 4])
      })
    ))

  it.live("ordered pull consumers advance their cursor across consecutive fetches", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.ordered`, payload)
        const consumer = yield* client.consumers.get(name)
        expect(yield* consumer.isPullConsumer).toBe(true)
        expect(yield* consumer.isPushConsumer).toBe(false)
        for (const expected of [1, 2, 3]) {
          const batch = yield* consumer.fetch({ max_messages: 1, expires: 1000 })
          const messages = yield* Stream.runCollect(batch.stream)
          expect(messages.map((message) => message.seq)).toEqual([expected])
        }
      })
    ))

  it.live("ordered pull consumers can start from a requested sequence", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.ordered`, payload)
        const consumer = yield* client.consumers.get(name, { opt_start_seq: 2 })
        expect(Option.getOrThrow(yield* consumer.next({ expires: 1000 })).seq).toBe(2)
      })
    ))

  it.live("named push consumers deliver stored messages and acknowledge through the native client", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, {
          durable_name: "push",
          ack_policy: AckPolicy.Explicit,
          deliver_subject: "native.parity.push.delivery",
          idle_heartbeat: 100_000_000,
          flow_control: true
        })
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.push`, payload)
        const consumer = yield* client.consumers.getPushConsumer(name, "push")
        expect(yield* consumer.isPushConsumer).toBe(true)
        expect(yield* consumer.isPullConsumer).toBe(false)
        const batch = yield* consumer.consume()
        const received = yield* batch.stream.pipe(Stream.take(3), Stream.runCollect)
        expect(received.map((message) => message.string())).toEqual(["one", "two", "three"])
        for (const message of received) expect(yield* message.ackAck()).toBe(true)
        expect((yield* manager.consumers.info(name, "push")).num_ack_pending).toBe(0)
      })
    ))

  it.live("an empty next returns None and leaves its consumer usable", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "empty", ack_policy: AckPolicy.Explicit })
        const consumer = yield* client.consumers.get(name, "empty")
        expect(yield* consumer.next({ expires: 1000 })).toEqual(Option.none())
        yield* client.publish(`${subject}.empty`, "after timeout")
        const message = Option.getOrThrow(yield* consumer.next({ expires: 1000 }))
        expect(message.string()).toBe("after timeout")
        yield* message.ackAck()
      })
    ))

  it.live("direct consumers advance their cursor across next and fetch", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        for (const payload of ["one", "two", "three", "four"]) {
          yield* client.publish(`${subject}.direct.cursor`, payload)
        }
        const consumer = yield* manager.direct.getConsumer(name, { seq: 2 })
        const first = Option.getOrThrow(yield* consumer.next)
        expect(first.seq).toBe(2)
        const batch = yield* consumer.fetch({ batch: 2 })
        const messages = yield* Stream.runCollect(batch.stream)
        expect(messages.map((message) => message.seq)).toEqual([3, 4])
        expect(yield* consumer.next).toEqual(Option.none())
      })
    ))

  it.live("direct consumer streams honor early consumer interruption", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.direct.stream`, payload)
        const consumer = yield* manager.direct.getConsumer(name)
        const messages = yield* consumer.consume({ batch: 1 })
        const received = yield* messages.stream.pipe(Stream.take(2), Stream.runCollect)
        expect(received.map((message) => message.seq)).toEqual([1, 2])
      })
    ))

  it.live("named pull consumption replenishes demand beyond its initial batch", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "demand", ack_policy: AckPolicy.Explicit })
        for (let index = 0; index < 150; index++) yield* client.publish(`${subject}.demand`, `${index}`)
        const consumer = yield* client.consumers.get(name, "demand")
        const iterator = yield* consumer.consume({ max_messages: 5, expires: 1000 })
        const received = yield* iterator.stream.pipe(
          Stream.take(150),
          Stream.mapEffect((message) => message.ack.pipe(Effect.as(message.seq))),
          Stream.runCollect
        )
        expect(received).toEqual(Array.from({ length: 150 }, (_, index) => index + 1))
      })
    ))

  it.live("ordered continuous consumption recreates a deleted consumer from its last delivered sequence", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* client.publish(`${subject}.reset`, "one")
        yield* client.publish(`${subject}.reset`, "two")
        const consumer = yield* client.consumers.get(name)
        const iterator = yield* consumer.consume({ max_messages: 1, expires: 1000 })
        const received = yield* Queue.unbounded<number>()
        const running = yield* iterator.stream.pipe(
          Stream.take(5),
          Stream.runForEach((message) => Queue.offer(received, message.seq)),
          Effect.forkChild
        )
        expect(yield* Queue.take(received)).toBe(1)
        expect(yield* Queue.take(received)).toBe(2)
        const oldName = (yield* consumer.info()).name
        yield* manager.consumers.delete(name, oldName)
        for (const payload of ["three", "four", "five"]) yield* client.publish(`${subject}.reset`, payload)
        expect(yield* Queue.take(received)).toBe(3)
        expect(yield* Queue.take(received)).toBe(4)
        expect(yield* Queue.take(received)).toBe(5)
        yield* Fiber.join(running)
        expect((yield* consumer.info()).name).not.toBe(oldName)
      })
    ))

  it.live("abort_on_missing_resource fails named consumption when its consumer is deleted", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "abort", ack_policy: AckPolicy.Explicit })
        const consumer = yield* client.consumers.get(name, "abort")
        const iterator = yield* consumer.consume({ max_messages: 1, expires: 1000, abort_on_missing_resource: true })
        const reading = yield* Stream.runDrain(iterator.stream).pipe(Effect.flip, Effect.forkChild)
        yield* manager.consumers.delete(name, "abort")
        const error = yield* Fiber.join(reading)
        expect(error._tag).toBe("JetStreamConsumerError")
        expect(error.reason.toLowerCase()).toMatch(/consumer|404|409/)
      })
    ))

  it.live("push status streams expose idle heartbeats without delivering them as application messages", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, {
          durable_name: "heartbeat",
          ack_policy: AckPolicy.Explicit,
          deliver_subject: "native.parity.heartbeat.delivery",
          idle_heartbeat: 100_000_000,
          flow_control: true
        })
        const consumer = yield* client.consumers.getPushConsumer(name, "heartbeat")
        const iterator = yield* consumer.consume()
        const status = yield* iterator.status
        const observed = yield* Deferred.make<void>()
        yield* status.pipe(
          Stream.filter((event) => event.type === "heartbeat"),
          Stream.take(1),
          Stream.runForEach(() => Deferred.succeed(observed, undefined)),
          Effect.forkChild
        )
        yield* Deferred.await(observed)
        expect(yield* iterator.getReceived).toBe(0)
        yield* iterator.close
      })
    ))

  it.live("consumer callbacks execute scoped Effects and acknowledge each delivery", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "callback", ack_policy: AckPolicy.Explicit })
        for (const payload of ["one", "two", "three"]) yield* client.publish(`${subject}.callback`, payload)
        const consumer = yield* client.consumers.get(name, "callback")
        const delivered = yield* Queue.unbounded<number>()
        const iterator = yield* consumer.consume({
          max_messages: 1,
          expires: 1000,
          callback: (message) =>
            message.ackAck().pipe(
              Effect.mapError((cause) =>
                new NATSError.JetStreamConsumerError({ reason: "Callback acknowledgement failed", cause })
              ),
              Effect.andThen(Queue.offer(delivered, message.seq)),
              Effect.asVoid
            )
        })
        expect(yield* Queue.take(delivered)).toBe(1)
        expect(yield* Queue.take(delivered)).toBe(2)
        expect(yield* Queue.take(delivered)).toBe(3)
        expect(yield* iterator.getPending).toBe(0)
        expect((yield* manager.consumers.info(name, "callback")).num_ack_pending).toBe(0)
        yield* iterator.close
      })
    ))

  it.live("a throwing consumer callback fails its completion with a typed error", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "callback-error", ack_policy: AckPolicy.Explicit })
        yield* client.publish(`${subject}.callback.error`, "failure")
        const consumer = yield* client.consumers.get(name, "callback-error")
        const iterator = yield* consumer.consume({
          max_messages: 1,
          expires: 1000,
          callback: () => {
            throw new Error("Callback failed intentionally")
          }
        })
        const error = yield* iterator.closed.pipe(Effect.flip)
        expect(error._tag).toBe("JetStreamConsumerError")
        expect(error.reason).toMatch(/callback/)
      })
    ))
  it.live("ordered push delivery honors its prefix and starting cursor", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        for (let index = 0; index < 4; index++) yield* client.publish(`${subject}.ordered.push`, `${index}`)
        const consumer = yield* client.consumers.getPushConsumer(name, {
          opt_start_seq: 2,
          deliver_prefix: "native.ordered.push"
        })
        const info = yield* consumer.info()
        expect(info.config.deliver_subject).toMatch(/^native\.ordered\.push\./)
        const messages = yield* consumer.consume()
        const received = yield* messages.stream.pipe(Stream.take(3), Stream.runCollect)
        expect(received.map((message) => message.seq)).toEqual([2, 3, 4])
        expect(yield* consumer.delete).toBe(true)
      })
    ))

  it.live("rejects named consumer APIs when pull and push kinds do not match", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        const pull = yield* manager.consumers.add(name, { durable_name: "kind_pull", ack_policy: AckPolicy.Explicit })
        const push = yield* manager.consumers.add(name, {
          durable_name: "kind_push",
          ack_policy: AckPolicy.Explicit,
          deliver_subject: "native.kind.push"
        })
        for (
          const invalid of [
            client.consumers.getPushConsumer(name, pull.name).pipe(Effect.asVoid),
            client.consumers.get(name, push.name).pipe(Effect.asVoid),
            client.consumers.getConsumerFromInfo(push).pipe(Effect.asVoid)
          ]
        ) expect((yield* invalid.pipe(Effect.flip))._tag).toBe("JetStreamConsumerError")
      })
    ))

  it.live("stream wrappers refresh cached information and decode stored JSON with typed failures", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const wrapper = yield* client.streams.get(name)
        const first = yield* client.publish(`${subject}.wrapper`, JSON.stringify({ value: 42 }))
        expect((yield* wrapper.info(true)).state.messages).toBe(0)
        expect((yield* wrapper.info()).state.messages).toBe(1)
        expect((yield* wrapper.info(true)).state.messages).toBe(1)
        expect(yield* wrapper.alternates).toEqual([])
        expect((yield* wrapper.best).name).toBe(name)
        const stored = Option.getOrThrow(yield* wrapper.getMessage({ seq: first.seq }))
        expect(yield* stored.json()).toEqual({ value: 42 })
        expect(yield* stored.json((_key, value) => typeof value === "number" ? value + 1 : value)).toEqual({
          value: 43
        })
        expect(yield* stored.decode(Schema.Struct({ value: Schema.Number }))).toEqual({ value: 42 })
        expect((yield* stored.decode(Schema.Struct({ value: Schema.String })).pipe(Effect.flip))._tag)
          .toBe("JetStreamStoredMessageError")
        yield* client.publish(`${subject}.wrapper`, "invalid JSON")
        const invalid = Option.getOrThrow(yield* wrapper.getMessage({ seq: 2 }))
        expect((yield* invalid.json().pipe(Effect.flip))._tag).toBe("JetStreamStoredMessageError")
        expect(yield* wrapper.deleteMessage(2)).toBe(true)
        expect(yield* wrapper.getMessage({ seq: 2 })).toEqual(Option.none())
      })
    ))
  it.live("continuous byte budgets replenish at the byte threshold without dropping messages", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "byte_demand", ack_policy: AckPolicy.Explicit })
        for (let index = 0; index < 20; index++) {
          yield* client.publish(`${subject}.byte.demand`, `${index}`.padEnd(100, "x"))
        }
        const consumer = yield* client.consumers.get(name, "byte_demand")
        const iterator = yield* consumer.consume({
          max_bytes: 1024,
          threshold_bytes: 512,
          expires: 1000
        })
        const received = yield* iterator.stream.pipe(
          Stream.take(20),
          Stream.mapEffect((message) => message.ack.pipe(Effect.as(message.seq))),
          Stream.runCollect
        )
        expect(received).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
      })
    ))

  it.live("stream consumer reset returns its new cursor and resumes from the requested sequence", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, { durable_name: "reset_cursor", ack_policy: AckPolicy.Explicit })
        for (let index = 0; index < 5; index++) yield* client.publish(`${subject}.reset.cursor`, `${index}`)
        const wrapper = yield* client.streams.get(name)
        const reset = yield* wrapper.resetConsumer("reset_cursor", 3)
        expect(reset).toMatchObject({ reset_seq: 3, name: "reset_cursor", stream_name: name })
        const consumer = yield* wrapper.getConsumer("reset_cursor")
        const message = Option.getOrThrow(yield* consumer.next({ expires: 1000 }))
        expect(message.seq).toBe(3)
        yield* message.ackAck()
      })
    ))
  it.live("management advisories decode consumer creation and deletion events", () =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        const connection = yield* NATSConnection.NATSConnection
        const running = yield* manager.advisoryStream.pipe(
          Stream.filter((event) => event.kind === "consumer_action"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* connection.flush
        const created = yield* manager.consumers.add(name, {
          durable_name: "advisory_consumer",
          ack_policy: AckPolicy.Explicit
        })
        yield* manager.consumers.delete(name, created.name)
        const events = yield* Fiber.join(running)
        expect(events.map((event) => event.kind)).toEqual(["consumer_action", "consumer_action"])
        const actions = yield* Effect.forEach(events, (event) =>
          Schema.decodeUnknownEffect(Schema.Struct({ action: Schema.String }))(event.data))
        expect(actions.map((event) =>
          event.action
        )).toEqual(["create", "delete"])
      })
    ))
  it.live("ordered push consumption recreates a deleted consumer without replaying accepted messages", () =>
    withStream(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        const consumer = yield* client.consumers.getPushConsumer(name)
        const initial = yield* consumer.info()
        yield* manager.consumers.delete(name, initial.name)
        yield* manager.consumers.add(name, { ...initial.config, idle_heartbeat: 100_000_000 })
        yield* consumer.info()
        const iterator = yield* consumer.consume()
        const queue = yield* Queue.unbounded<number>()
        const running = yield* iterator.stream.pipe(
          Stream.take(4),
          Stream.runForEach((message) => Queue.offer(queue, message.seq)),
          Effect.forkChild
        )
        for (const payload of ["one", "two"]) yield* client.publish(`${subject}.push.reset`, payload)
        expect(yield* Queue.take(queue)).toBe(1)
        expect(yield* Queue.take(queue)).toBe(2)
        yield* manager.consumers.delete(name, initial.name)
        for (const payload of ["three", "four"]) yield* client.publish(`${subject}.push.reset`, payload)
        expect(yield* Queue.take(queue)).toBe(3)
        expect(yield* Queue.take(queue)).toBe(4)
        yield* Fiber.join(running)
        expect((yield* consumer.info()).name).not.toBe(initial.name)
      })
    ))
  it.live.each([RetentionPolicy.Limits, RetentionPolicy.Interest, RetentionPolicy.Workqueue])(
    "retention policy %s preserves or removes acknowledged messages as specified",
    (retention) =>
      withStream(
        Effect.gen(function*() {
          const manager = yield* JetStreamManager.JetStreamManager
          const client = yield* JetStreamClient.JetStreamClient
          const retentionName = `${name}_RETENTION`
          const retentionSubject = `native.retention.${retention}`
          yield* Effect.acquireRelease(
            manager.streams.add({
              name: retentionName,
              subjects: [retentionSubject],
              storage: StorageType.Memory,
              retention
            }),
            () => manager.streams.delete(retentionName).pipe(Effect.orDie)
          )
          yield* manager.consumers.add(retentionName, {
            durable_name: "retention",
            ack_policy: AckPolicy.Explicit
          })
          yield* client.publish(retentionSubject, "retained until acknowledgement")
          const consumer = yield* client.consumers.get(retentionName, "retention")
          const message = Option.getOrThrow(yield* consumer.next({ expires: 1000 }))
          yield* message.ackAck()
          const expected = retention === RetentionPolicy.Limits ? 1 : 0
          const count = yield* manager.streams.info(retentionName).pipe(
            Effect.flatMap((info) =>
              info.state.messages === expected
                ? Effect.succeed(info.state.messages)
                : Effect.fail(new Error("Acknowledgement retention update is pending"))
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 })
          )
          expect(count).toBe(expected)
        })
      )
  )
  it.live.each([
    { label: "description", update: { description: "updated stream" } },
    { label: "subject list", update: { subjects: [`${subject}.>`, "native.additional"] } },
    { label: "per subject count", update: { max_msgs_per_subject: 5 } },
    { label: "total count", update: { max_msgs: 100 } },
    { label: "age", update: { max_age: 90_000_000_000 } },
    { label: "bytes", update: { max_bytes: 10240 } },
    { label: "message size", update: { max_msg_size: 1024 } },
    { label: "discard", update: { discard: DiscardPolicy.New } },
    { label: "duplicate window", update: { duplicate_window: 15_000_000_000 } },
    { label: "rollup", update: { allow_rollup_hdrs: true } },
    { label: "deny deletion", update: { deny_delete: true } },
    { label: "deny purge", update: { deny_purge: true } }
  ])("stream management preserves accepted update: $label", (options) =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        const updated = yield* manager.streams.update(name, options.update)
        expect(updated.config).toMatchObject(options.update)
        expect((yield* manager.streams.info(name)).config).toMatchObject(options.update)
      })
    ))

  it.live.each([
    { label: "storage", update: { storage: StorageType.File } }
  ])("stream management rejects immutable update: $label", (options) =>
    withStream(
      Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        // @ts-expect-error Intentional invalid storage change exercises the broker rejection.
        expect((yield* manager.streams.update(name, options.update).pipe(Effect.flip))._tag)
          .toBe("JetStreamStreamAPIError")
        expect((yield* manager.streams.info(name)).config).toMatchObject({
          name,
          storage: StorageType.Memory,
          retention: RetentionPolicy.Limits
        })
      })
    ))
})
