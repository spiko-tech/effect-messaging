import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Option, Schema, Stream } from "effect"
import * as Api from "../src/internal/jetstreamApi.ts"
import * as Publish from "../src/internal/jetstreamPublish.ts"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { AckPolicy, StorageType } from "../src/JetStreamTypes.ts"
import type * as NATSConnection from "../src/NATSConnection.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import { makeServer } from "./server.ts"

const fixture = (config: Partial<T.StreamConfig> = {}) =>
  Effect.gen(function*() {
    const server = yield* makeServer()
    const connection = yield* Node.make({ servers: server.url })
    const manager = JetStreamManager.make(connection)
    const client = JetStreamClient.make(connection)
    const name = "publisher"
    yield* manager.streams.add({ name, subjects: ["q"], storage: StorageType.Memory, ...config })
    return { connection, manager, client, name }
  })

describe("official atomic and fast ingest publisher laws", () => {
  it.live("batch publisher - basics", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_atomic: true })
      const batch = yield* client.startBatch("q", "a")
      for (let index = 0; index < 98; index++) yield* batch.add("q", String(index), { ack: index % 20 === 0 })
      const ack = yield* batch.commit("q", "lastone")
      expect(ack).toMatchObject({ seq: 100, stream: name, count: 100, batch: batch.id })
      expect((yield* manager.streams.info(name)).state.messages).toBe(100)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("batch publisher - out of sequence", () =>
    Effect.gen(function*() {
      const { connection } = yield* fixture({ allow_atomic: true })
      const modified: NATSConnection.NATSConnection = {
        ...connection,
        request: (subject, payload, options) => {
          if (options?.headers?.get("Nats-Batch-Commit") === "1") options.headers.set("Nats-Batch-Sequence", "3")
          return connection.request(subject, payload, options)
        }
      }
      const batch = yield* JetStreamClient.make(modified).startBatch("q", "a")
      expect((yield* batch.commit("q", "c").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* batch.add("q", "late").pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("batch publisher - two streams", () =>
    Effect.gen(function*() {
      const { client, manager } = yield* fixture({ allow_atomic: true })
      yield* manager.streams.add({
        name: "other",
        subjects: ["other"],
        allow_atomic: true,
        storage: StorageType.Memory
      })
      const batch = yield* client.startBatch("q", "a")
      expect((yield* batch.add("other", "b", { ack: true }).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* batch.commit("q", "a").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* manager.streams.info("other")).state.messages).toBe(0)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("batch publisher - expect last seq", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_atomic: true })
      const batch = yield* client.startBatch("q", "a", { expect: { lastSequence: 5 } })
      expect((yield* batch.commit("q", "").pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("batch publisher - no atomics", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture()
      expect((yield* client.startBatch("q", "a").pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - basics", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 5 })
      for (let index = 2; index <= 4; index++) yield* batch.add("q", String(index))
      const ack = yield* batch.last("q", "5")
      expect(ack).toMatchObject({ stream: name, batch: batch.batch, count: 5, seq: 5 })
      expect((yield* manager.streams.info(name)).state.messages).toBe(5)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - rejects non_supported", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture()
      expect((yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 5 }).pipe(Effect.result))._tag)
        .toBe("Failure")
      expect((yield* manager.streams.info(name)).state.messages).toBe(0)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - end (EOB)", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 5 })
      yield* batch.add("q", "2")
      yield* batch.add("q", "3")
      expect(yield* batch.end()).toMatchObject({ batch: batch.batch, count: 3 })
      expect((yield* manager.streams.info(name)).state.messages).toBe(3)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - ping", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 10 })
      yield* batch.add("q", "2")
      expect((yield* batch.ping()).batchSeq).toBe(2)
      expect((yield* batch.last("q", "3")).count).toBe(3)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - backpressure", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 2 })
      for (let index = 2; index <= 20; index++) yield* batch.add("q", String(index))
      expect((yield* batch.last("q", "21")).count).toBe(21)
      expect((yield* manager.streams.info(name)).state.messages).toBe(21)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - add after closed rejects", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false })
      yield* batch.last("q", "2")
      expect((yield* batch.add("q", "3").pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each(["FI", "_inbox.foo.bar.baz"])(
    "fast ingest custom and multi-token inbox prefix %s",
    (inboxPrefix) =>
      Effect.gen(function*() {
        const { client } = yield* fixture({ allow_batched: true })
        const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, inboxPrefix })
        yield* batch.add("q", "2")
        expect((yield* batch.last("q", "3")).count).toBe(3)
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("fast ingest - invalid inboxPrefix rejected", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_batched: true })
      for (const inboxPrefix of ["", " ", "has space", "*", ">", "foo.*", "foo.>"]) {
        expect((yield* client.startFastIngest("q", "1", { allowGaps: false, inboxPrefix }).pipe(Effect.result))._tag)
          .toBe("Failure")
      }
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - concurrent pings coalesce", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, ackInterval: 10 })
      yield* batch.add("q", "2")
      const results = yield* Effect.all([batch.ping(), batch.ping()], { concurrency: "unbounded" })
      expect(results[0]).toEqual(results[1])
      yield* batch.last("q", "3")
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - expect.lastSequence on first msg", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_batched: true })
      yield* client.publish("q", "0")
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, expect: { lastSequence: 1 } })
      yield* batch.add("q", "2")
      expect((yield* batch.last("q", "3")).count).toBe(3)
      expect((yield* manager.streams.info(name)).state.messages).toBe(4)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - expect.lastSequence mismatch closes batch", () =>
    Effect.gen(function*() {
      const { client, manager, name } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false, expect: { lastSequence: 5 } })
      expect((yield* batch.last("q", "2").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* manager.streams.info(name)).state.messages).toBe(0)
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("fast ingest - done() resolves with terminal ack", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({ allow_batched: true })
      const batch = yield* client.startFastIngest("q", "1", { allowGaps: false })
      yield* batch.add("q", "2")
      const ack = yield* batch.last("q", "3")
      expect(yield* batch.done).toEqual(ack)
      expect(ack).toMatchObject({ batch: batch.batch, count: 3 })
    }).pipe(Effect.scoped), { timeout: 30_000 })
})

describe("official schedule publishing laws", () => {
  it.effect("schedules - spec to header", () =>
    Effect.gen(function*() {
      const date = new Date("2026-01-01T00:00:00.000Z")
      for (
        const [specification, expected] of [
          ["@every 1s", "@every 1s"],
          [date, "@at 2026-01-01T00:00:00.000Z"],
          [{ at: date }, "@at 2026-01-01T00:00:00.000Z"],
          [{ at: "2026-01-01T00:00:00Z" }, "@at 2026-01-01T00:00:00Z"],
          [{ every: "1s" }, "@every 1s"],
          [{ cron: "0 0 5 * * *" }, "0 0 5 * * *"],
          [{ predefined: "@hourly" }, "@hourly"],
          [{ every: "1m30s" }, "@every 1m30s"]
        ] satisfies Array<[T.ScheduleOptions["specification"], string]>
      ) {
        expect((yield* Publish.publishHeaders({ schedule: { specification, target: "target" } })).get("Nats-Schedule"))
          .toBe(expected)
      }
      for (const every of ["500ms", "999ms", "1x", ""]) {
        expect(
          (yield* Publish.publishHeaders({ schedule: { specification: { every }, target: "target" } }).pipe(
            Effect.result
          ))._tag
        ).toBe("Failure")
      }
    }))
  it.live("schedules - basics", () =>
    Effect.gen(function*() {
      const { connection, manager, client } = yield* fixture({
        subjects: ["sched.>", "target.>"],
        allow_msg_schedules: true,
        allow_msg_ttl: true
      })
      const sub = yield* connection.subscribe("schedule.deliver", { max: 2 })
      yield* manager.consumers.add("publisher", {
        deliver_subject: "schedule.deliver",
        filter_subject: "target.>",
        ack_policy: AckPolicy.None
      })
      const received = yield* sub.stream.pipe(
        Stream.map((message) => message.subject),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const now = yield* Clock.currentTimeMillis
      yield* client.publish("sched.first", "900", {
        schedule: { specification: "@at " + new Date(now + 900).toISOString(), target: "target.900", ttl: "5m" }
      })
      yield* client.publish("sched.second", "500", {
        schedule: { specification: new Date(now + 500), target: "target.500", ttl: "5m" }
      })
      expect((yield* Fiber.join(received).pipe(Effect.timeout("5 seconds"))).sort()).toEqual([
        "target.500",
        "target.900"
      ])
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each(["every", "cron"] as const)(
    "schedules recurring %s publishes real target messages",
    (mode) =>
      Effect.gen(function*() {
        const { connection, manager, client } = yield* fixture({
          subjects: ["sched.>", "tgt.>"],
          allow_msg_schedules: true,
          allow_msg_ttl: true
        })
        const sub = yield* connection.subscribe("schedule.deliver", { max: mode === "every" ? 2 : 1 })
        yield* manager.consumers.add("publisher", {
          deliver_subject: "schedule.deliver",
          filter_subject: "tgt.>",
          ack_policy: AckPolicy.None
        })
        const received = yield* sub.stream.pipe(
          Stream.mapEffect(() => Clock.currentTimeMillis),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* client.publish("sched.recurring", "tick", {
          schedule: {
            specification: mode === "every" ? { every: "1s" } : { cron: "* * * * * *" },
            target: "tgt.recurring",
            ttl: "5m"
          }
        })
        const times = yield* Fiber.join(received).pipe(Effect.timeout("5 seconds"))
        if (mode === "every") {
          const delta = (times[1] ?? 0) - (times[0] ?? 0)
          expect(delta).toBeGreaterThanOrEqual(800)
          expect(delta).toBeLessThanOrEqual(2500)
        } else expect(times).toHaveLength(1)
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("schedules - predefined and timezone accepted", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({
        subjects: ["sched.>", "tgt.>"],
        allow_msg_schedules: true,
        allow_msg_ttl: true
      })
      yield* client.publish("sched.hourly", "tick", {
        schedule: {
          specification: { predefined: "@hourly" },
          target: "tgt.hourly",
          timezone: "America/Denver",
          ttl: "5m"
        }
      })
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("schedules - cancel schedule", () =>
    Effect.gen(function*() {
      const { connection, manager, client } = yield* fixture({
        subjects: ["sched.>", "tgt.>", "stop.>"],
        allow_msg_schedules: true,
        allow_msg_ttl: true
      })
      const sub = yield* connection.subscribe("schedule.deliver", { max: 1 })
      yield* manager.consumers.add("publisher", {
        deliver_subject: "schedule.deliver",
        filter_subject: "stop.>",
        ack_policy: AckPolicy.None
      })
      yield* client.publish("sched.cancel", "tick", {
        schedule: { specification: { every: "1s" }, target: "tgt.cancelled", ttl: "5m" }
      })
      yield* client.publish("stop.canceled", "stopped", { cancelSchedule: { scheduleSubject: "sched.cancel" } })
      expect(Option.getOrThrow(yield* sub.stream.pipe(Stream.runHead, Effect.timeout("5 seconds"))).subject).toBe(
        "stop.canceled"
      )
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live.each(["same subject", "mutually exclusive"] as const)(
    "schedules reject %s cancellation",
    (mode) =>
      Effect.gen(function*() {
        const { client } = yield* fixture({ subjects: ["sched.>"], allow_msg_schedules: true })
        const options: Partial<T.JetStreamPublishOptions> = mode === "same subject"
          ? { cancelSchedule: { scheduleSubject: "sched.x" } }
          : {
            schedule: { specification: { every: "1s" }, target: "tgt.x" },
            cancelSchedule: { scheduleSubject: "sched.y" }
          }
        expect((yield* client.publish("sched.x", "", options).pipe(Effect.result))._tag).toBe("Failure")
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  )
  it.live("schedules - rollup header", () =>
    Effect.gen(function*() {
      const { client } = yield* fixture({
        subjects: ["sched.>", "tgt.>"],
        allow_msg_schedules: true,
        allow_msg_ttl: true,
        allow_rollup_hdrs: true
      })
      yield* client.publish("sched.rollup", "tick", {
        schedule: { specification: { every: "1s" }, target: "tgt.rollup", rollup: "sub", ttl: "5m" }
      })
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("schedules - subject sourcing (ADR-51)", () =>
    Effect.gen(function*() {
      const { connection, manager, client } = yield* fixture({
        subjects: ["sched.>", "tgt.>", "data.>"],
        allow_msg_schedules: true,
        allow_msg_ttl: true
      })
      const sub = yield* connection.subscribe("schedule.deliver", { max: 1 })
      yield* manager.consumers.add("publisher", {
        deliver_subject: "schedule.deliver",
        filter_subject: "tgt.>",
        ack_policy: AckPolicy.None
      })
      yield* client.publish("data.last", "sourced-payload")
      yield* client.publish("sched.source", "", {
        schedule: { specification: { every: "1s" }, target: "tgt.sourced", source: "data.last", ttl: "5m" }
      })
      expect(yield* Option.getOrThrow(yield* sub.stream.pipe(Stream.runHead, Effect.timeout("5 seconds"))).string).toBe(
        "sourced-payload"
      )
    }).pipe(Effect.scoped), { timeout: 30_000 })
  it.live("api error - basics", () =>
    Effect.gen(function*() {
      const { connection, manager, name } = yield* fixture({ allow_direct: true })
      expect(yield* manager.streams.getMessage(name, { seq: 1 })).toEqual(Option.none())
      const reply = yield* connection.request(`$JS.API.STREAM.MSG.GET.${name}`, JSON.stringify({ seq: 1 }))
      const failure = yield* Api.make(connection).decode(reply.data, Schema.Struct({})).pipe(Effect.flip)
      expect(failure.apiError).toMatchObject({ code: 404, err_code: 10037, description: "no message found" })
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
