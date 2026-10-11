import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import { AckPolicy, DiscardPolicy, StorageType } from "../src/JetStreamTypes.ts"
import type * as T from "../src/JetStreamTypes.ts"
import * as NATSAuth from "../src/NATSAuth.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSHeaders from "../src/NATSHeaders.ts"
import type * as NATSOptions from "../src/NATSOptions.ts"
import { makeJetStreamJWTFixture } from "./fixtures/jwt.ts"
import { makeServer } from "./server.ts"

type Fixture = {
  manager: JetStreamManager.JetStreamManager
  client: JetStreamClient.JetStreamClient
  connection: NATSConnection.NATSConnection
  name: string
  subject: string
  add: (config?: Partial<T.StreamConfig>) => Effect.Effect<T.StreamInfo, unknown>
}
const withManager = <A, E, R>(run: (f: Fixture) => Effect.Effect<A, E, R>, create = true, servers = "localhost:4222") =>
  Effect.gen(function*() {
    const connection = yield* NATSConnection.NATSConnection
    const manager = JetStreamManager.make(connection)
    const client = JetStreamClient.make(connection)
    const name = `MANAGER_${crypto.randomUUID().replaceAll("-", "")}`
    const subject = `${name}.a`
    const streams = new Set<string>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(streams, (stream) =>
        manager.streams.delete(stream).pipe(
          Effect.catch((error) => error.apiError?.err_code === 10059 ? Effect.void : Effect.fail(error)),
          Effect.orDie
        ), { concurrency: 8 })
    )
    const add = (config: Partial<T.StreamConfig> = {}) =>
      manager.streams.add({
        name,
        subjects: [`${name}.>`],
        storage: StorageType.Memory,
        ...config
      }).pipe(Effect.tap((info) =>
        Effect.sync(() => {
          streams.add(info.config.name)
        })
      ))
    if (create) yield* add()
    return yield* run({ manager, client, connection, name, subject, add })
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers })))
const isolated = <A, E, R>(run: (f: Fixture) => Effect.Effect<A, E, R>, create = true) =>
  Effect.gen(function*() {
    const server = yield* makeServer()
    return yield* withManager(run, create, server.url)
  }).pipe(Effect.scoped)
const stored = (f: Fixture, seq: number) =>
  f.manager.streams.getMessage(f.name, { seq }).pipe(Effect.map(Option.getOrThrow))
const consumer = (f: Fixture, config: Partial<T.ConsumerConfig> = {}) =>
  f.manager.consumers.add(f.name, { durable_name: "dur", ack_policy: AckPolicy.Explicit, ...config })
const failure = (effect: Effect.Effect<unknown, { reason: string }>, text?: string) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        if (text) expect(error.reason.toLowerCase()).toContain(text.toLowerCase())
        expect(error.reason.length).toBeGreaterThan(0)
      })
    ),
    Effect.asVoid
  )
const publishNine = (f: Fixture) =>
  Effect.forEach(
    Array.from({ length: 9 }, (_, i) => i),
    (i) => f.client.publish(`${f.name}.${["a", "b", "c"][i % 3]}`, `${i}`)
  )
const configWithoutServerMetadata = (config: T.StreamConfig) => ({
  ...config,
  metadata: Object.fromEntries(Object.entries(config.metadata ?? {}).filter(([key]) => !key.startsWith("_nats.")))
})
const invalidNames = ["", ".", "*", ">", "\r", "\n", "\t", " "]

describe("Official JetStream management cases", () => {
  it.live("jsm - account info", () =>
    withManager((f) =>
      f.manager.accountInfo.pipe(
        Effect.tap((info) =>
          Effect.sync(() => {
            expect(info.limits.max_memory === -1 || info.limits.max_memory > 0).toBe(true)
          })
        ),
        Effect.asVoid
      )
    ))
  for (
    const [name, operation] of [
      ["jsm - delete empty stream name fails", (f: Fixture) => f.manager.streams.delete("")],
      ["jsm - info empty stream name fails", (f: Fixture) => f.manager.streams.info("")],
      ["jsm - delete msg empty stream name fails", (f: Fixture) => f.manager.streams.deleteMessage("", 1)],
      ["jsm - purge empty stream name fails", (f: Fixture) => f.manager.streams.purge("")],
      ["jsm - info msg not found stream name fails", (f: Fixture) => f.manager.streams.info(`${f.name}_absent`)],
      [
        "jsm - delete msg not found stream name fails",
        (f: Fixture) => f.manager.streams.deleteMessage(`${f.name}_absent`, 1)
      ],
      ["jsm - purge not found stream name fails", (f: Fixture) => f.manager.streams.purge(`${f.name}_absent`)],
      ["jsm - consumer info on empty stream name fails", (f: Fixture) => f.manager.consumers.info("", "")],
      ["jsm - consumer info on empty consumer name fails", (f: Fixture) => f.manager.consumers.info(f.name, "")],
      [
        "jsm - consumer info on not found stream fails",
        (f: Fixture) => f.manager.consumers.info(`${f.name}_absent`, "dur")
      ],
      ["jsm - consumer info on not found consumer", (f: Fixture) => f.manager.consumers.info(f.name, "dur")],
      ["jsm - no consumer lister with empty stream fails", (f: Fixture) => f.manager.consumers.list("")]
    ] as const
  ) {
    it.live(name, () => withManager((f) => failure(operation(f))))
  }
  it.live("jsm - empty stream config fails", () =>
    withManager((f) => {
      // @ts-expect-error Runtime input boundary deliberately omits required stream name.
      return failure(f.manager.streams.add({}))
    }))
  for (
    const name of [
      "jsm - empty stream config update fails",
      "jsm - update stream name is internally added",
      "jsm - update stream"
    ]
  ) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          if (name === "jsm - empty stream config update fails") yield* failure(f.manager.streams.update("", {}))
          const info = yield* f.manager.streams.update(f.name, { subjects: [`${f.name}.>`, `${f.name}_extra`] })
          expect(info.config.subjects).toEqual([`${f.name}.>`, `${f.name}_extra`])
          expect(info.config.name).toBe(f.name)
        })
      ))
  }
  for (
    const name of ["jsm - no stream lister is empty", "jsm - stream names is empty", "jsm - lister after empty, empty"]
  ) {
    it.live(name, () =>
      isolated((f) =>
        Effect.gen(function*() {
          if (name === "jsm - stream names is empty") {
            expect(yield* (yield* f.manager.streams.names()).next()).toEqual([])
          } else {
            const lister = yield* f.manager.streams.list()
            expect(yield* lister.next()).toEqual([])
            if (name === "jsm - lister after empty, empty") expect(yield* lister.next()).toEqual([])
          }
        }), false))
  }
  it.live("jsm - add stream", () =>
    isolated((f) =>
      Effect.gen(function*() {
        const info = yield* f.add()
        const same = yield* f.manager.streams.info(f.name)
        expect(configWithoutServerMetadata(same.config)).toEqual(configWithoutServerMetadata(info.config))
        expect(same.state).toEqual(info.state)
        expect(same.created).toEqual(info.created)
        expect(configWithoutServerMetadata((yield* (yield* f.manager.streams.list()).next())[0].config)).toEqual(
          configWithoutServerMetadata(info.config)
        )
        yield* f.client.publish(f.subject)
        expect((yield* (yield* f.manager.streams.list()).next())[0].state.messages).toBe(1)
      }), false))
  for (
    const [name, options, purged, first, remaining] of [
      ["jsm - stream purge", {}, 9, 10, 0],
      ["jsm - purge by sequence", { seq: 4 }, 3, 4, 6],
      ["jsm - purge by filtered sequence", { seq: 4, filter: "b" }, 1, 1, 8],
      ["jsm - purge by subject [416]", { filter: "b" }, 3, 1, 6],
      ["jsm - purge by subject [446]", { filter: "b" }, 3, 1, 6],
      ["jsm - purge keep", { keep: 1 }, 8, 9, 1]
    ] as const
  ) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          yield* publishNine(f)
          const opts = "filter" in options ? { ...options, filter: `${f.name}.${options.filter}` } : options
          expect((yield* f.manager.streams.purge(f.name, opts)).purged).toBe(purged)
          const info = yield* f.manager.streams.info(f.name)
          expect(info.state.first_seq).toBe(first)
          expect(info.state.messages).toBe(remaining)
        })
      ))
  }
  it.live("jsm - purge filtered keep", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* publishNine(f)
        for (const letter of ["a", "b", "c"]) {
          expect((yield* f.manager.streams.purge(f.name, { keep: 1, filter: `${f.name}.${letter}` })).purged).toBe(2)
        }
        const info = yield* f.manager.streams.info(f.name)
        expect(info.state.first_seq).toBe(7)
        expect(info.state.messages).toBe(3)
      })
    ))
  it.live("jsm - purge seq and keep fails", () =>
    withManager((f) => failure(f.manager.streams.purge(f.name, { keep: 10, seq: 5 }), "mutually exclusive")))
  it.live("jsm - stream delete", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.client.publish(f.subject)
        expect(yield* f.manager.streams.delete(f.name)).toBe(true)
        yield* failure(f.manager.streams.info(f.name), "stream not found")
      })
    ))
  it.live("jsm - stream delete message", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.client.publish(f.subject)
        expect((yield* f.manager.streams.info(f.name)).state.messages).toBe(1)
        expect(yield* f.manager.streams.deleteMessage(f.name, 1)).toBe(true)
        const info = yield* f.manager.streams.info(f.name)
        expect(info.state.messages).toBe(0)
        expect(info.state.first_seq).toBe(2)
        expect(info.state.last_seq).toBe(1)
      })
    ))
  it.live("jsm - stream delete info", () =>
    withManager((f) =>
      Effect.gen(function*() {
        for (let i = 0; i < 3; i++) yield* f.client.publish(f.subject)
        yield* f.manager.streams.deleteMessage(f.name, 2)
        const info = yield* f.manager.streams.info(f.name, { deleted_details: true })
        expect(info.state.num_deleted).toBe(1)
        expect(info.state.deleted).toEqual([2])
      })
    ))
  it.live("jsm - consumer info", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* consumer(f)
        const info = yield* f.manager.consumers.info(f.name, "dur")
        expect(info.name).toBe("dur")
        expect(info.config.durable_name).toBe("dur")
        expect(info.config.ack_policy).toBe(AckPolicy.Explicit)
      })
    ))
  it.live("jsm - no consumer lister with no consumers empty", () =>
    withManager((f) =>
      Effect.gen(function*() {
        expect(yield* (yield* f.manager.consumers.list(f.name)).next()).toEqual([])
      })
    ))
  it.live("jsm - lister", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* consumer(f)
        const values = yield* (yield* f.manager.consumers.list(f.name)).next()
        expect(values).toHaveLength(1)
        expect(values[0].config.durable_name).toBe("dur")
        yield* f.manager.consumers.delete(f.name, "dur")
        expect(yield* (yield* f.manager.consumers.list(f.name)).next()).toEqual([])
      })
    ))
  it.live("jsm - get message", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const headers = NATSHeaders.headers()
        headers.set("xxx", "a")
        yield* f.client.publish(f.subject, "1", { headers })
        yield* f.client.publish(f.subject, "2")
        for (const seq of [1, 2]) {
          const message = yield* stored(f, seq)
          expect(message.subject).toBe(f.subject)
          expect(message.seq).toBe(seq)
          expect(yield* message.json()).toBe(seq)
        }
        expect((yield* stored(f, 1)).header.get("xxx")).toBe("a")
        expect(yield* f.manager.streams.getMessage(f.name, { seq: 3 })).toEqual(Option.none())
      })
    ))
  it.live("jsm - get message (not found)", () =>
    withManager((f) =>
      Effect.gen(function*() {
        expect(yield* f.manager.streams.getMessage(f.name, { last_by_subj: f.subject })).toEqual(Option.none())
      })
    ))
  it.live("jsm - get message payload", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.client.publish(f.subject, new Uint8Array(), { msgID: "empty" })
        yield* f.client.publish(f.subject, "", { msgID: "empty2" })
        for (const seq of [1, 2]) {
          const message = yield* stored(f, seq)
          expect(message.data).toEqual(new Uint8Array())
          expect(message.seq).toBe(seq)
          expect(yield* message.string).toBe("")
        }
      })
    ))
  it.live("jsm - stored msg decode", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.client.publish(f.subject, "hello")
        yield* f.client.publish(f.subject, JSON.stringify({ one: "two", a: [1, 2, 3] }))
        expect(yield* (yield* stored(f, 1)).string).toBe("hello")
        expect(yield* (yield* stored(f, 2)).json()).toEqual({ one: "two", a: [1, 2, 3] })
        expect(
          yield* (yield* stored(f, 2)).decode(Schema.Struct({ one: Schema.String, a: Schema.Array(Schema.Number) }))
        )
          .toEqual({ one: "two", a: [1, 2, 3] })
      })
    ))
  it.live("jsm - update consumer", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* consumer(f, { ack_wait: 2_000_000_000, max_ack_pending: 500, headers_only: false, max_deliver: 100 })
        const info = yield* f.manager.consumers.update(f.name, "dur", {
          ack_wait: 3_000_000_000,
          max_ack_pending: 5,
          headers_only: true,
          max_deliver: 2
        })
        expect(info.config.ack_wait).toBe(3_000_000_000)
        expect(info.config.max_ack_pending).toBe(5)
        expect(info.config.headers_only).toBe(true)
        expect(info.config.max_deliver).toBe(2)
      })
    ))
  it.live("jsm - stream update preserves other value", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.add({ discard: DiscardPolicy.New })
        const info = yield* f.manager.streams.update(f.name, { subjects: [`${f.name}.>`, `${f.name}_extra`] })
        expect(info.config.discard).toBe(DiscardPolicy.New)
        expect(info.config.subjects).toHaveLength(2)
      }), false))
  it.live("jsm - jetstream error info", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const error = yield* f.manager.streams.add({
          name: `${f.name}_cluster`,
          subjects: [`${f.name}_cluster`],
          num_replicas: 3
        }).pipe(Effect.flip)
        expect(error.apiError?.code).toBe(500)
        expect(error.reason).toContain("replicas > 1 not supported")
      })
    ))
  it.live("jsm - stream info subjects", () =>
    withManager((f) =>
      Effect.gen(function*() {
        for (const suffix of ["a", "a.b", "a.b.c"]) yield* f.client.publish(`${f.name}.${suffix}`)
        const info = yield* f.manager.streams.info(f.name, { subjects_filter: ">" })
        expect(info.state.num_subjects).toBe(3)
        expect(Object.keys(info.state.subjects ?? {})).toHaveLength(3)
        for (const suffix of ["a", "a.b", "a.b.c"]) expect(info.state.subjects?.[`${f.name}.${suffix}`]).toBe(1)
        expect(
          Object.keys(
            (yield* f.manager.streams.info(f.name, { subjects_filter: `${f.name}.a.>` })).state.subjects ?? {}
          )
        )
          .toHaveLength(2)
        expect((yield* f.manager.streams.info(f.name)).state.subjects).toBeUndefined()
      })
    ))
  for (const name of ["jsm - validate name", "jsm - minValidation", "jsm - validate stream name in operations"]) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          for (const value of [...invalidNames, "hello.", "hello.*", "hello.>", "one.two", "one*two", "one>two"]) {
            const operations = [
              f.manager.streams.add({ name: value }),
              f.manager.streams.info(value),
              f.manager.streams.update(value, {}),
              f.manager.streams.purge(value),
              f.manager.streams.delete(value),
              f.manager.streams.getMessage(value, { seq: 1 }),
              f.manager.streams.deleteMessage(value, 1)
            ]
            for (const operation of operations) yield* failure(operation, "name")
          }
          expect((yield* f.manager.streams.info(f.name)).config.name).toBe(f.name)
        })
      ))
  }
  for (
    const name of [
      "jsm - consumer name is validated",
      "jsm - validate consumer name",
      "jsm - validate consumer name in operations"
    ]
  ) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          for (const value of invalidNames) {
            for (
              const operation of [
                f.manager.consumers.info(f.name, value),
                f.manager.consumers.delete(f.name, value),
                f.manager.consumers.update(f.name, value, {})
              ]
            ) yield* failure(operation, "name")
            if (value !== "") {
              for (const config of [{ name: value }, { durable_name: value }]) {
                yield* failure(consumer(f, config), "name")
              }
            }
          }
        })
      ))
  }
  it.live("jsm - consumers with name and durable_name", () =>
    withManager((f) =>
      Effect.gen(function*() {
        expect((yield* consumer(f, { name: "x", durable_name: "x" })).name).toBe("x")
        yield* failure(consumer(f, { name: "y", durable_name: "z" }), "durable name")
      })
    ))
  it.live("jsm - filter_subjects", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const info = yield* consumer(f, { filter_subjects: [`${f.name}.b`, `${f.name}.c`] })
        expect(info.config.filter_subject).toBeUndefined()
        expect(info.config.filter_subjects).toEqual([`${f.name}.b`, `${f.name}.c`])
      })
    ))
  it.live("jsm - filter_subjects rejects filter_subject", () =>
    withManager((f) =>
      failure(consumer(f, { filter_subject: `${f.name}.a`, filter_subjects: [`${f.name}.b`, `${f.name}.c`] }), "both")
    ))
  for (const multiple of [false, true]) {
    it.live(
      multiple ? "jsm - update filter_subjects" : "jsm - update filter_subject",
      () =>
        withManager((f) =>
          Effect.gen(function*() {
            yield* consumer(f, multiple ? { filter_subjects: [`${f.name}.x`] } : { filter_subject: `${f.name}.x` })
            const info = yield* f.manager.consumers.update(
              f.name,
              "dur",
              multiple ? { filter_subjects: [`${f.name}.x`, `${f.name}.y`] } : { filter_subject: `${f.name}.y` }
            )
            if (multiple) expect(info.config.filter_subjects).toEqual([`${f.name}.x`, `${f.name}.y`])
            else expect(info.config.filter_subject).toBe(`${f.name}.y`)
          })
        )
    )
  }
  it.live("jsm - update from filter_subject to filter_subjects", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* consumer(f, { filter_subject: `${f.name}.x` })
        yield* failure(
          f.manager.consumers.update(f.name, "dur", { filter_subjects: [`${f.name}.x`, `${f.name}.y`] }),
          "both"
        )
        const multi = yield* f.manager.consumers.update(f.name, "dur", {
          filter_subject: "",
          filter_subjects: [`${f.name}.x`, `${f.name}.y`]
        })
        expect(multi.config.filter_subject).toBeUndefined()
        expect(multi.config.filter_subjects).toHaveLength(2)
        yield* failure(f.manager.consumers.update(f.name, "dur", { filter_subject: `${f.name}.x` }), "both")
        const single = yield* f.manager.consumers.update(f.name, "dur", {
          filter_subject: `${f.name}.x`,
          filter_subjects: []
        })
        expect(single.config.filter_subject).toBe(`${f.name}.x`)
        expect(single.config.filter_subjects).toBeUndefined()
      })
    ))
  it.live("jsm - consumer api action", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* failure(
          f.manager.consumers.add(f.name, { durable_name: "dur", ack_policy: AckPolicy.Explicit }, {
            action: "update"
          }),
          "does not exist"
        )
        yield* consumer(f)
        yield* failure(consumer(f, { inactive_threshold: 60_000_000_000 }), "already exists")
      })
    ))
  it.live("jsm - discard_new_per_subject option", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* failure(
          f.manager.streams.add({
            name: f.name,
            subjects: [f.subject],
            discard_new_per_subject: true,
            max_msgs_per_subject: 1
          }),
          "discard new"
        )
        const info = yield* f.add({
          discard: DiscardPolicy.New,
          discard_new_per_subject: true,
          max_msgs_per_subject: 1
        })
        expect(info.config.discard_new_per_subject).toBe(true)
        yield* f.client.publish(f.subject)
        yield* failure(f.client.publish(f.subject), "maximum messages per subject")
      }), false))
  for (const override of [false, true]) {
    it.live(
      override ? "jsm - stream consumer limits override" : "jsm - stream consumer limits",
      () =>
        withManager((f) =>
          Effect.gen(function*() {
            const info = yield* f.add({ consumer_limits: { max_ack_pending: 20, inactive_threshold: 60_000_000_000 } })
            expect(info.config.consumer_limits?.max_ack_pending).toBe(20)
            expect(info.config.consumer_limits?.inactive_threshold).toBe(60_000_000_000)
            const ci = yield* consumer(f, override ? { max_ack_pending: 19, inactive_threshold: 59_000_000_000 } : {})
            expect(ci.config.max_ack_pending).toBe(override ? 19 : 20)
            expect(ci.config.inactive_threshold).toBe(override ? 59_000_000_000 : 60_000_000_000)
            if (override) yield* failure(consumer(f, { max_ack_pending: 100 }), "exceeds system limit")
            else {
              const updated = yield* f.manager.streams.update(f.name, {
                consumer_limits: { max_ack_pending: 200, inactive_threshold: 120_000_000_000 }
              })
              expect(updated.config.consumer_limits?.max_ack_pending).toBe(200)
              expect(updated.config.consumer_limits?.inactive_threshold).toBe(120_000_000_000)
            }
          }), false)
    )
  }
  it.live("jsm - consumer pedantic", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.add({ consumer_limits: { max_ack_pending: 10 } })
        yield* consumer(f, { name: "a", durable_name: "a" })
        yield* failure(
          f.manager.consumers.add(f.name, { name: "b", ack_policy: AckPolicy.Explicit, max_ack_pending: 0 }, {
            pedantic: true
          }),
          "pedantic"
        )
      }), false))
  it.live("jsm - stream compression", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const info = yield* f.add({ storage: StorageType.File, compression: "s2" })
        expect(info.config.compression).toBe("s2")
        expect((yield* f.manager.streams.update(f.name, { compression: "none" })).config.compression).toBe("none")
      }), false))
  for (
    const [name, config] of [
      ["jsm - stream compression not supported", { compression: "s2" }],
      ["jsm - stream consumer limits rejected on old servers", { consumer_limits: { max_ack_pending: 20 } }],
      ["jsm - source transforms rejected on old servers", { subject_transform: { src: "foo", dest: "bar" } }]
    ] as const
  ) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          const older = JetStreamManager.make({
            ...f.connection,
            info: Option.map(f.connection.info, (info) => ({ ...info, version: "2.9.0" }))
          })
          yield* failure(older.streams.add({ name: `${f.name}_old`, subjects: [`${f.name}_old`], ...config }), "2.10.0")
          if (name.includes("transforms")) {
            for (const source of ["mirror", "sources"]) {
              const cfg = { name: f.name, subject_transforms: [{ src: f.subject, dest: `${f.name}_transformed` }] }
              yield* failure(
                older.streams.add({
                  name: `${f.name}_old`,
                  ...(source === "mirror" ? { mirror: cfg } : { sources: [cfg] })
                }),
                "2.10.0"
              )
            }
          }
        })
      ))
  }
  it.live("jsm - consumer create paused", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const info = yield* consumer(f, { pause_until: new Date(Date.now() + 86_400_000).toISOString() })
        expect(info.paused).toBe(true)
      })
    ))
  it.live("jsm - pause/unpause", () =>
    withManager((f) =>
      Effect.gen(function*() {
        expect((yield* consumer(f)).paused).toBeUndefined()
        expect((yield* f.manager.consumers.pause(f.name, "dur", new Date(Date.now() + 86_400_000))).paused).toBe(true)
        expect((yield* f.manager.consumers.resume(f.name, "dur")).paused).toBe(false)
      })
    ))
  it.live("jsm - stream/consumer metadata", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const info = yield* f.add({ metadata: { hello: "world" } })
        expect(configWithoutServerMetadata(info.config).metadata).toEqual({ hello: "world" })
        expect(
          configWithoutServerMetadata((yield* f.manager.streams.update(f.name, { metadata: { one: "two" } })).config)
            .metadata
        ).toEqual({ one: "two" })
        expect((yield* consumer(f, { metadata: { test: "true" } })).config.metadata?.test).toBe("true")
        expect((yield* f.manager.consumers.update(f.name, "dur", { metadata: { foo: "bar" } })).config.metadata?.foo)
          .toBe("bar")
        const older = JetStreamManager.make({
          ...f.connection,
          info: Option.map(f.connection.info, (info) => ({ ...info, version: "2.9.0" }))
        })
        yield* failure(older.streams.add({ name: `${f.name}_old`, metadata: { x: "y" } }), "2.10.0")
        yield* failure(older.streams.update(f.name, { metadata: { x: "y" } }), "2.10.0")
        yield* failure(older.consumers.add(f.name, { durable_name: "old", metadata: { x: "y" } }), "2.10.0")
        yield* failure(older.consumers.update(f.name, "dur", { metadata: { x: "y" } }), "2.10.0")
      }), false))
  it.live("jsm - storage", () =>
    withManager((f) =>
      Effect.gen(function*() {
        expect((yield* f.add()).config.storage).toBe(StorageType.Memory)
        expect((yield* consumer(f, { mem_storage: true })).config.mem_storage).toBe(true)
        const file = `${f.name}_file`
        expect((yield* f.add({ name: file, subjects: [file], storage: StorageType.File })).config.storage).toBe(
          StorageType.File
        )
        expect((yield* f.manager.consumers.add(file, { name: "fc", mem_storage: false })).config.mem_storage)
          .toBeUndefined()
      }), false))
  it.live("jsm - pull consumer priority groups", () =>
    withManager((f) =>
      Effect.gen(function*() {
        // @ts-expect-error Runtime boundary deliberately supplies a scalar instead of the required array.
        yield* failure(consumer(f, { priority_groups: "hello" }), "priority_groups")
        yield* failure(consumer(f, { priority_groups: [] }), "priority_groups")
        yield* failure(consumer(f, { priority_groups: ["hello"] }), "priority_policy")
        // @ts-expect-error Runtime boundary deliberately supplies an invalid policy.
        yield* failure(consumer(f, { priority_groups: ["hello"], priority_policy: "hello" }), "priority_policy")
        const info = yield* consumer(f, { priority_groups: ["hello"], priority_policy: "overflow" })
        expect(info.config.priority_groups).toEqual(["hello"])
        expect(info.config.priority_policy).toBe("overflow")
      })
    ))
  it.live("jsm - stream message ttls", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const info = yield* f.add({ allow_msg_ttl: true, subject_delete_marker_ttl: 60_000_000_000 })
        expect(info.config.allow_msg_ttl).toBe(true)
        expect(info.config.subject_delete_marker_ttl).toBe(60_000_000_000)
        yield* f.manager.streams.update(f.name, { subject_delete_marker_ttl: 0 })
        yield* failure(f.manager.streams.update(f.name, { allow_msg_ttl: false }), "can not be disabled")
      }), false))
  it.live("jsm - message ttls", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* f.add({ allow_msg_ttl: true })
        yield* f.client.publish(f.subject, "hello", { ttl: "4s" })
        const started = Date.now()
        while (Option.isSome(yield* f.manager.streams.getMessage(f.name, { last_by_subj: f.subject }))) {
          yield* Effect.sleep(100)
        }
        const elapsed = Date.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(4000)
        expect(elapsed).toBeLessThan(4300)
      }), false), 10_000)
  for (const name of ["jsm - mirror_direct options", "jsm - mirrors can be removed", "jsm - source transforms"]) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          yield* f.add({ allow_direct: true })
          yield* f.client.publish(f.subject, "1")
          yield* f.client.publish(`${f.name}.b`, "2")
          const mirrorName = `${f.name}_mirror`
          const transforms = [{ src: f.subject, dest: `${f.name}_transformed_a` }, {
            src: `${f.name}.b`,
            dest: `${f.name}_transformed_b`
          }]
          const info = yield* f.add({
            name: mirrorName,
            subjects: [],
            allow_direct: true,
            mirror_direct: true,
            mirror: {
              name: f.name,
              ...(name.includes("transforms") || name.includes("removed") ? { subject_transforms: transforms } : {})
            }
          })
          expect(info.config.allow_direct).toBe(true)
          expect(info.config.mirror_direct).toBe(true)
          expect(info.config.mirror?.name).toBe(f.name)
          if (name.includes("transforms")) {
            expect(info.config.mirror?.subject_transforms).toEqual(transforms)
            const c = yield* f.client.consumers.get(mirrorName)
            const messages = yield* c.fetch({ max_messages: 2, expires: 1000 })
            expect((yield* messages.stream.pipe(Stream.runCollect)).map((m) => m.subject)).toEqual(
              transforms.map((t) => t.dest)
            )
          }
          if (name.includes("removed")) {
            expect((yield* f.manager.streams.update(mirrorName, { mirror: undefined })).config.mirror).toBeUndefined()
          }
        }), false))
  }
  for (
    const [name, enabled, kind, update, plain, expected] of [
      ["jsm - sendRequiredApiLevel sets header on stream create", true, "stream", false, false, "4"],
      ["jsm - sendRequiredApiLevel default omits header", false, "stream", false, false, undefined],
      ["jsm - sendRequiredApiLevel header on consumer create", true, "consumer", false, false, "1"],
      ["jsm - sendRequiredApiLevel header on stream update", true, "stream", true, false, "4"],
      ["jsm - sendRequiredApiLevel stream update no header when delta plain", true, "stream", true, true, undefined],
      ["jsm - sendRequiredApiLevel header on consumer update", true, "consumer", true, false, "1"],
      ["jsm - sendRequiredApiLevel consumer update unrelated edit no header", true, "consumer", true, true, undefined]
    ] as const
  ) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          const requests: Array<{ subject: string; header: string | undefined }> = []
          const manager = JetStreamManager.make({
            ...f.connection,
            request: (subject, payload, options) =>
              f.connection.request(subject, payload, options).pipe(Effect.tap(() =>
                Effect.sync(() => {
                  requests.push({ subject, header: options?.headers?.get("Nats-Required-Api-Level") })
                })
              ))
          }, { sendRequiredApiLevel: enabled })
          if (kind === "stream") {
            if (update) {
              if (plain) yield* f.manager.streams.update(f.name, { allow_batched: true })
              yield* manager.streams.update(f.name, plain ? { description: "updated" } : { allow_batched: true })
            } else {
              yield* f.manager.streams.update(f.name, { allow_batched: true })
              const info = yield* f.manager.streams.info(f.name)
              yield* manager.streams.add(info.config)
            }
          } else {
            if (update) {
              yield* consumer(f, plain ? { priority_policy: "overflow", priority_groups: ["g1"] } : {})
              yield* manager.consumers.update(
                f.name,
                "dur",
                plain ? { description: "edited" } : { pause_until: new Date(Date.now() + 60_000).toISOString() }
              )
            } else {yield* manager.consumers.add(f.name, {
                ack_policy: AckPolicy.Explicit,
                priority_policy: "overflow",
                priority_groups: ["g1"]
              })}
          }
          const mutation = requests.find((request) => !request.subject.includes(".INFO."))
          expect(mutation).toBeDefined()
          expect(mutation?.header).toBe(expected)
        })
      ))
  }
  for (const name of ["jsm - consumer name", "jsm - consumer name apis are not used on old servers"]) {
    it.live(name, () =>
      withManager((f) =>
        Effect.gen(function*() {
          const old = name.includes("old servers")
          const requests: Array<string> = []
          const manager = JetStreamManager.make({
            ...f.connection,
            info: Option.map(f.connection.info, (info) => ({ ...info, version: old ? "2.7.0" : info.version })),
            request: (subject, payload, options) =>
              f.connection.request(subject, payload, options).pipe(Effect.tap(() =>
                Effect.sync(() => {
                  requests.push(subject)
                })
              ))
          })
          if (old) yield* failure(manager.consumers.add(f.name, { name: "a", ack_policy: AckPolicy.Explicit }), "2.9.0")
          else {
            const named = yield* manager.consumers.add(f.name, {
              name: "a",
              inactive_threshold: 1_000_000_000,
              ack_policy: AckPolicy.Explicit
            })
            expect(named.config.inactive_threshold).toBe(1_000_000_000)
            expect(requests.at(-1)).toBe(`$JS.API.CONSUMER.CREATE.${f.name}.a`)
            yield* manager.consumers.add(f.name, {
              name: "c",
              filter_subject: f.subject,
              ack_policy: AckPolicy.Explicit
            })
            expect(requests.at(-1)).toBe(`$JS.API.CONSUMER.CREATE.${f.name}.c.${f.subject}`)
          }
          const ephemeral = yield* manager.consumers.add(f.name, {
            ack_policy: AckPolicy.Explicit,
            inactive_threshold: 1_000_000_000
          })
          expect(ephemeral.name.length).toBeGreaterThan(0)
          expect(requests.at(-1)).toBe(`$JS.API.CONSUMER.CREATE.${f.name}`)
          const durable = yield* manager.consumers.add(f.name, { durable_name: "b", ack_policy: AckPolicy.Explicit })
          expect(durable.config.durable_name).toBe("b")
          expect(requests.at(-1)).toBe(
            old ? `$JS.API.CONSUMER.DURABLE.CREATE.${f.name}.b` : `$JS.API.CONSUMER.CREATE.${f.name}.b`
          )
        })
      ))
  }
  for (const enabled of [false, true]) {
    it.live(enabled ? "jsm - api check ok" : "jsm - api check not ok", () =>
      withManager((f) =>
        Effect.gen(function*() {
          let count = 0
          const connection = {
            ...f.connection,
            request: (subject: string, payload?: NATSOptions.Payload, options?: Partial<NATSOptions.RequestOptions>) =>
              f.connection.request(subject, payload, options).pipe(Effect.tap(() =>
                Effect.sync(() => {
                  if (subject.endsWith(".INFO")) count++
                })
              ))
          }
          const acquire = (options: T.JetStreamManagerOptions) =>
            Effect.scoped(
              Effect.gen(function*() {
                yield* JetStreamManager.JetStreamManager
              }).pipe(
                Effect.provide(JetStreamManager.layer(options)),
                Effect.provideService(NATSConnection.NATSConnection, connection)
              )
            )
          if (enabled) {
            yield* acquire({})
            yield* acquire({ checkAPI: true })
            yield* JetStreamClient.make(connection).jetstreamManager()
            yield* JetStreamClient.make(connection, { checkAPI: true }).jetstreamManager()
            yield* JetStreamClient.make(connection, { checkAPI: true }).jetstreamManager(false)
            expect(count).toBe(4)
          } else {
            yield* acquire({ checkAPI: false })
            yield* JetStreamClient.make(connection).jetstreamManager(false)
            yield* JetStreamClient.make(connection, { checkAPI: false }).jetstreamManager()
            yield* JetStreamClient.make(connection, { checkAPI: false }).jetstreamManager(true)
            yield* JetStreamClient.make(connection).jetstreamManager()
            expect(count).toBe(2)
          }
        })
      ))
  }
  it.live("jsm - advisories", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const waiting = yield* f.manager.advisoryStream.pipe(
          Stream.filter((advisory) => advisory.kind === "stream_action"),
          Stream.runHead,
          Effect.forkChild
        )
        yield* f.connection.flush
        yield* f.add()
        expect(Option.isSome(yield* Fiber.join(waiting).pipe(Effect.timeout("1 second")))).toBe(true)
      }), false))
  it.live("jsm - remap domain", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const payloads: Array<T.StreamSource> = []
        const manager = JetStreamManager.make({
          ...f.connection,
          request: (subject, payload, options) => {
            if (subject.includes(".CREATE.")) {
              const config = JSON.parse(
                typeof payload === "string" ? payload : new TextDecoder().decode(payload)
              ) as Partial<T.StreamConfig>
              if (config.mirror) payloads.push(config.mirror)
              if (config.sources) payloads.push(...config.sources)
            }
            return f.connection.request(subject, payload, options)
          }
        })
        yield* manager.streams.add({ name: `${f.name}_domain`, mirror: { name: "a", domain: "a" } }).pipe(Effect.exit)
        yield* manager.streams.add({
          name: `${f.name}_domains`,
          sources: [{ name: "x", domain: "x" }, { name: "b", external: { api: "$JS.b.API" } }]
        }).pipe(Effect.exit)
        expect(payloads).toEqual([{ name: "a", external: { api: "$JS.a.API" } }, {
          name: "x",
          external: { api: "$JS.x.API" }
        }, { name: "b", external: { api: "$JS.b.API" } }])
        yield* f.manager.streams.delete(`${f.name}_domain`).pipe(Effect.exit)
        yield* f.manager.streams.delete(`${f.name}_domains`).pipe(Effect.exit)
      })
    ))
  it.live("jsm - jetstream not enabled", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({ jetstream: false })
      const result = yield* Effect.gen(function*() {
        yield* JetStreamManager.JetStreamManager
      }).pipe(
        Effect.provide(JetStreamManager.layer()),
        Effect.provide(NATSConnection.layerNode({ servers: server.url })),
        Effect.flip
      )
      expect(result.reason.toLowerCase()).toContain("responders")
    }).pipe(Effect.scoped))
  it.live("jsm - account not enabled", () =>
    Effect.gen(function*() {
      const server = yield* makeServer({
        config:
          "no_auth_user: b\naccounts { A { jetstream: enabled, users: [{user:a,password:a}] }, B { users: [{user:b}] } }"
      })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        yield* failure(JetStreamManager.make(connection).accountInfo)
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url })))
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        expect((yield* JetStreamManager.make(connection).accountInfo).limits.max_memory).not.toBe(0)
      }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "a", pass: "a" })))
    }).pipe(Effect.scoped))
  it.live("jsm - account limits", () =>
    Effect.gen(function*() {
      const jwt = yield* makeJetStreamJWTFixture()
      const server = yield* makeServer({ config: jwt.config })
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const info = yield* JetStreamManager.make(connection).accountInfo
        expect(info.tiers?.R1?.limits.max_storage).toBe(1048576)
        expect(info.tiers?.R1?.limits.max_consumers).toBe(-1)
        expect(info.tiers?.R1?.limits.max_streams).toBe(-1)
        expect(info.tiers?.R1?.limits.max_ack_pending).toBe(-1)
      }).pipe(
        Effect.provide(
          NATSConnection.layerNode({ servers: server.url, authenticator: NATSAuth.jwtAuthenticator(jwt.bearerJWT) })
        )
      )
    }).pipe(Effect.scoped), 15_000)
  for (const consumers of [false, true]) {
    it.live(consumers ? "jsm - cross account consumers" : "jsm - cross account streams", () =>
      Effect.gen(function*() {
        const server = yield* makeServer({
          config:
            "no_auth_user: a\naccounts { JS { jetstream: enabled, users: [{user:js,password:js}], exports: [{service:\"$JS.API.>\",response_type:stream},{service:\"$JS.ACK.>\",response_type:stream}] }, A { users: [{user:a,password:s3cret}], imports: [{service:{subject:\"$JS.API.>\",account:JS},to:\"IPA.>\"},{service:{subject:\"$JS.ACK.>\",account:JS}}] } }"
        })
        yield* withManager(
          (f) =>
            Effect.gen(function*() {
              const manager = JetStreamManager.make(f.connection, { apiPrefix: "IPA" })
              expect((yield* manager.options).apiPrefix).toBe("IPA")
              yield* manager.accountInfo
              expect(yield* (yield* manager.streams.list()).next()).toEqual([])
              yield* Effect.acquireRelease(
                manager.streams.add({ name: f.name, subjects: [f.subject] }),
                () =>
                  manager.streams.delete(f.name).pipe(
                    Effect.catchIf((error) => error.apiError?.err_code === 10059, () => Effect.succeed(false)),
                    Effect.orDie
                  )
              )
              if (consumers) {
                expect(yield* (yield* manager.consumers.list(f.name)).next()).toEqual([])
                yield* manager.consumers.add(f.name, { durable_name: "me", ack_policy: AckPolicy.Explicit })
              }
              yield* Effect.gen(function*() {
                const admin = yield* NATSConnection.NATSConnection
                yield* admin.publish(f.subject)
                yield* admin.publish(f.subject)
                yield* admin.flush
              }).pipe(Effect.provide(NATSConnection.layerNode({ servers: server.url, user: "js", pass: "js" })))
              if (consumers) {
                const list = yield* (yield* manager.consumers.list(f.name)).next()
                expect(list).toHaveLength(1)
                expect(list[0].name).toBe("me")
                expect(list[0].config.durable_name).toBe("me")
                expect(list[0].num_pending).toBe(2)
                const info = yield* manager.consumers.info(f.name, "me")
                expect(info.config.durable_name).toBe("me")
                expect(info.num_pending).toBe(2)
                expect(yield* manager.consumers.delete(f.name, "me")).toBe(true)
                yield* failure(manager.consumers.info(f.name, "me"), "consumer not found")
              } else {
                expect((yield* manager.streams.info(f.name)).state.messages).toBe(2)
                expect(Option.getOrThrow(yield* manager.streams.getMessage(f.name, { seq: 1 })).seq).toBe(1)
                expect(yield* manager.streams.deleteMessage(f.name, 1)).toBe(true)
                expect((yield* manager.streams.info(f.name)).state.messages).toBe(1)
                expect((yield* manager.streams.purge(f.name)).purged).toBe(1)
                expect((yield* manager.streams.info(f.name)).state.messages).toBe(0)
                expect(
                  (yield* manager.streams.update(f.name, { subjects: [f.subject, `${f.name}.b`] })).config.subjects
                ).toHaveLength(2)
                expect(yield* manager.streams.find(`${f.name}.b`)).toBe(f.name)
                expect(yield* manager.streams.delete(f.name)).toBe(true)
                expect(yield* (yield* manager.streams.list()).next()).toEqual([])
              }
            }),
          false,
          server.url
        )
      }).pipe(Effect.scoped), 15_000)
  }
  for (const names of [false, true]) {
    it.live(
      names ? "jsm - stream names list filtering subject" : "jsm - list filter",
      () =>
        withManager((f) =>
          Effect.gen(function*() {
            const spec = [["foo"], ["bar"], ["foo.*", "bar.*"], ["foo-1.A"], ["foo.A.bar.B"], ["foo.C.bar.D.E"]]
            for (const [i, subjects] of spec.entries()) {
              yield* f.add({
                name: `${f.name}_s${i + 1}`,
                subjects: subjects.map((subject) => `${f.name}.${subject}`)
              })
            }
            for (
              const [filter, expected] of [["foo", [1]], ["bar", [2]], ["*", [1, 2]], [">", [1, 2, 3, 4, 5, 6]], [
                "*.A",
                [3, 4]
              ]] as const
            ) {
              const actual = names
                ? yield* (yield* f.manager.streams.names(`${f.name}.${filter}`)).stream.pipe(Stream.runCollect)
                : yield* (yield* f.manager.streams.list(`${f.name}.${filter}`)).stream.pipe(
                  Stream.map((value) => value.config.name),
                  Stream.runCollect
                )
              expect(actual.sort()).toEqual(expected.map((i) => `${f.name}_s${i}`).sort())
            }
          }), false)
    )
  }
  it.live("jsm - paged stream list", () =>
    withManager((f) =>
      Effect.gen(function*() {
        for (let i = 0; i < 257; i++) yield* f.add({ name: `${f.name}_s${i}`, subjects: [`${f.name}.s.${i}`] })
        const lister = yield* f.manager.streams.list(`${f.name}.>`)
        const values = yield* lister.stream.pipe(Stream.runCollect)
        expect(values).toHaveLength(257)
        expect(new Set(values.map((info) => info.config.name))).toEqual(
          new Set(Array.from({ length: 257 }, (_, i) => `${f.name}_s${i}`))
        )
      }), false), 15_000)
  it.live("jsm - paged consumer infos", () =>
    withManager((f) =>
      Effect.gen(function*() {
        for (let i = 0; i < 257; i++) {
          yield* f.manager.consumers.add(f.name, { durable_name: `${i}`, ack_policy: AckPolicy.None })
        }
        const values = yield* (yield* f.manager.consumers.list(f.name)).stream.pipe(Stream.runCollect)
        expect(values).toHaveLength(257)
        expect(
          new Set(values.map((info) => info.name))
        ).toEqual(new Set(Array.from({ length: 257 }, (_, i) => `${i}`)))
      })
    ), 15_000)
  it.live("jsm - paginated subjects", () =>
    withManager((f) =>
      Effect.gen(function*() {
        yield* Effect.forEach(Array.from({ length: 100001 }, (_, i) => i + 1), (i) =>
          f.client.publish(`${f.name}.${i}`), { concurrency: 500 })
        const info = yield* f.manager.streams.info(f.name, { subjects_filter: ">" })
        expect(Object.keys(info.state.subjects ?? {})).toHaveLength(100001)
        expect(info.state.subjects?.[`${f.name}.100001`]).toBe(1)
      })
    ), 60_000)
  it.live("jsm - mirror/source consumer (ADR-60)", () =>
    withManager((f) =>
      Effect.gen(function*() {
        const configs = [
          { durable_name: "C", deliver_subject: `DELIVER.${f.name}.mirror` },
          { durable_name: "C2", deliver_subject: `DELIVER.${f.name}.source` }
        ]
        for (const cfg of configs) {
          yield* consumer(f, { ...cfg, ack_policy: AckPolicy.FlowControl, idle_heartbeat: 1_000_000_000 })
        }
        const mirror = yield* f.add({
          name: `${f.name}_mirror`,
          subjects: [],
          mirror: { name: f.name, consumer: { name: "C", deliver_subject: configs[0].deliver_subject } }
        })
        const source = yield* f.add({
          name: `${f.name}_source`,
          subjects: [],
          sources: [{ name: f.name, consumer: { name: "C2", deliver_subject: configs[1].deliver_subject } }]
        })
        expect(mirror.config.mirror?.consumer).toEqual({ name: "C", deliver_subject: configs[0].deliver_subject })
        expect(source.config.sources?.[0].consumer).toEqual({ name: "C2", deliver_subject: configs[1].deliver_subject })
        for (const suffix of ["a", "b", "c"]) {
          yield* f.client.publish(`${f.name}.${suffix}`)
        }
        for (const target of [mirror.config.name, source.config.name]) {
          yield* Effect.gen(function*() {
            while ((yield* f.manager.streams.info(target)).state.messages < 3) yield* Effect.sleep(100)
          }).pipe(Effect.timeout("5 seconds"))
        }
      })
    ), 10_000)
  it.live("jsm - mirror/source consumer requires name and deliver_subject (ADR-60)", () =>
    withManager((f) =>
      Effect.gen(function*() {
        for (const kind of ["mirror", "sources"]) {
          for (const cfg of [{ name: "", deliver_subject: "d.x" }, { name: "C", deliver_subject: "" }]) {
            const source = { name: f.name, consumer: cfg }
            yield* failure(
              f.manager.streams.add({
                name: `${f.name}_bad`,
                ...(kind === "mirror" ? { mirror: source } : { sources: [source] })
              }),
              `${kind === "mirror" ? "mirror" : "source"} consumer config is invalid`
            )
          }
        }
      })
    ))
})
