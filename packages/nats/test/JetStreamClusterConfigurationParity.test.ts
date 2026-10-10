import { describe, expect, it } from "@effect/vitest"
import { jetstreamManager as officialManager } from "@nats-io/jetstream"
import { connect as officialConnect } from "@nats-io/transport-node"
import { Effect, Exit, Schedule } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { DiscardPolicy, RetentionPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeCluster } from "./cluster.ts"

const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 }))

describe("Exact upstream clustered stream configuration laws", { concurrent: false }, () => {
  it.live.each([false, true])("cluster mirrors with explicit placement=%s", (placed) =>
    Effect.gen(function*() {
      const servers = yield* makeCluster
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const client = JetStreamClient.make(connection)
        const manager = yield* ready(client.jetstreamManager())
        const placement = (index: number) =>
          placed ?
            {
              placement: { cluster: "effect-native-parity", tags: ["parity-node-" + index] }
            } :
            {}
        yield* manager.streams.add({ name: "src", subjects: ["A", "B"], ...placement(1) })
        yield* manager.streams.add({ name: "mirror", mirror: { name: "src" }, ...placement(2) })
        expect(yield* manager.streams.find("A")).toBe("src")
        const wrapper = yield* client.streams.get("src")
        expect(wrapper.name).toBe("src")
        const alternates = yield* ready(wrapper.alternates.pipe(Effect.flatMap((values) =>
          values.length === 2 ? Effect.succeed(values) : Effect.fail(new Error("Mirror registration pending"))
        )))
        expect(
          alternates.map((value) =>
            value.name
          ).sort()
        ).toEqual(["mirror", "src"])
        expect((yield* manager.streams.info("src")).alternates).toHaveLength(2)
        expect((yield* client.streams.get("another").pipe(Effect.flip)).reason).toMatch(/stream not found/)
        const best = yield* wrapper.best
        const selected = (yield* wrapper.info(true)).alternates?.[0]?.name ?? ""
        expect(best.name).toBe(selected)
        if (placed) {
          expect((yield* manager.streams.info("src")).cluster?.leader).toBe(servers[1].name)
          expect((yield* manager.streams.info("mirror")).cluster?.leader).toBe(servers[2].name)
        }
      }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: servers[0].url })))
    }).pipe(Effect.scoped), { timeout: 30_000 })

  it.live("jsm - stream update properties", () =>
    Effect.gen(function*() {
      const servers = yield* makeCluster
      yield* Effect.gen(function*() {
        const connection = yield* NATSConnection.NATSConnection
        const manager = yield* ready(JetStreamClient.make(connection).jetstreamManager())
        yield* manager.streams.add({ name: "a", storage: StorageType.File, subjects: ["x"] })
        yield* manager.streams.add({
          name: "n",
          storage: StorageType.File,
          subjects: ["subj"],
          duplicate_window: 30_000_000_000
        })
        const referenceConnection = yield* Effect.acquireRelease(
          Effect.tryPromise(() => officialConnect({ servers: servers[0].url })),
          (client) => Effect.promise(() => client.close())
        )
        const reference = yield* Effect.tryPromise(() => officialManager(referenceConnection))
        yield* Effect.tryPromise(() => reference.streams.add({ name: "reference", subjects: ["reference-subj"] }))
        expect(
          (yield* manager.streams.update("n", { name: "nn" } as Partial<T.StreamUpdateConfig>)
            .pipe(Effect.flip)).reason
        ).toBeTruthy()
        for (
          const patch of [
            { retention: RetentionPolicy.Interest },
            { storage: StorageType.Memory },
            { max_consumers: 5 }
          ]
        ) {
          // Exercise the same invalid JavaScript boundary inputs as upstream; immutable fields are omitted by the type.
          const native = yield* manager.streams.update("n", patch as Partial<T.StreamUpdateConfig>).pipe(Effect.exit)
          const official = yield* Effect.tryPromise(() =>
            reference.streams.update("reference", patch as Parameters<typeof reference.streams.update>[1])
          )
            .pipe(Effect.exit)
          // Broker2.15 permits retention changes; assert current official parity for historical immutable laws.
          expect(Exit.isSuccess(native)).toBe(Exit.isSuccess(official))
          if (Exit.isSuccess(native)) expect(native.value.config).toMatchObject(patch)
        }
        const patches: Array<Partial<T.StreamUpdateConfig>> = [
          { subjects: ["subj", "a"] },
          { description: "xx" },
          { max_msgs_per_subject: 5 },
          { max_msgs: 100 },
          { max_age: 45_000_000_000 },
          { max_bytes: 10240 },
          { max_msg_size: 10240 },
          { discard: DiscardPolicy.New },
          { no_ack: true },
          { duplicate_window: 15_000_000_000 },
          { allow_rollup_hdrs: true },
          { allow_rollup_hdrs: false },
          { num_replicas: 3 },
          { num_replicas: 1 },
          { deny_delete: true },
          { deny_purge: true },
          { sources: [{ name: "a" }] },
          { sealed: true }
        ]
        for (const patch of patches) {
          const info = yield* manager.streams.update("n", patch)
          expect(info.config).toMatchObject(patch)
        }
        expect((yield* manager.streams.update("n", { sealed: false }).pipe(Effect.flip)).reason).toMatch(/sealed/)
        yield* manager.streams.add({ name: "m", mirror: { name: "a" } })
        expect((yield* manager.streams.update("n", { mirror: { name: "nn" } }).pipe(Effect.flip)).reason).toBeTruthy()
      }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: servers[0].url })))
    }).pipe(Effect.scoped), { timeout: 30_000 })
})
