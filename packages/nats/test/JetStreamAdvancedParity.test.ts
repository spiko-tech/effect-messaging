import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import { AckPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeServer } from "./server.ts"

const name = "ADVANCED_PARITY"
const subject = "advanced.parity"
const layer = (url: string) =>
  JetStreamClient.layer().pipe(
    Layer.provideMerge(JetStreamManager.layer()),
    Layer.provideMerge(NATSConnection.layerNode({ servers: url }))
  )
const withBroker = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const server = yield* makeServer()
    return yield* Effect.gen(function*() {
      const manager = yield* JetStreamManager.JetStreamManager
      yield* manager.streams.add({
        name,
        subjects: [`${subject}.>`],
        storage: StorageType.Memory,
        allow_atomic: true,
        allow_batched: true,
        allow_msg_schedules: true,
        allow_msg_ttl: true
      })
      return yield* test
    }).pipe(Effect.scoped, Effect.provide(layer(server.url)))
  }).pipe(Effect.scoped)

describe("Isolated JetStream advanced parity against NATS server 2.15.0", () => {
  it.live("commits an atomic batch with per-message acknowledgement barriers", () =>
    withBroker(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        const batch = yield* client.startBatch(`${subject}.batch`, "first")
        for (let index = 0; index < 18; index++) {
          yield* batch.add(`${subject}.batch`, `${index}`, { ack: index % 3 === 0 })
        }
        const ack = yield* batch.commit(`${subject}.batch`, "last")
        expect(ack).toMatchObject({ stream: name, count: 20, seq: 20, batch: batch.id })
        expect((yield* manager.streams.info(name)).state.messages).toBe(20)
        expect((yield* batch.add(`${subject}.batch`, "after commit").pipe(Effect.flip))._tag).toBe(
          "JetStreamBatchError"
        )
      })
    ), { timeout: 30_000 })

  it.live.each([1, 2, 5])(
    "fast ingest respects its acknowledgement flow window, ackInterval=%s",
    (ackInterval) =>
      withBroker(
        Effect.gen(function*() {
          const client = yield* JetStreamClient.JetStreamClient
          const manager = yield* JetStreamManager.JetStreamManager
          const ingest = yield* client.startFastIngest(`${subject}.ingest`, "first", { allowGaps: false, ackInterval })
          for (let index = 2; index < 20; index++) yield* ingest.add(`${subject}.ingest`, `${index}`)
          const ack = yield* ingest.last(`${subject}.ingest`, "last")
          expect(ack).toMatchObject({ stream: name, count: 20, seq: 20, batch: ingest.batch })
          expect(yield* ingest.done).toEqual(ack)
          expect((yield* manager.streams.info(name)).state.messages).toBe(20)
          expect((yield* ingest.add(`${subject}.ingest`, "after end").pipe(Effect.flip))._tag).toBe(
            "JetStreamBatchError"
          )
        })
      ),
    { timeout: 30_000 }
  )

  it.live(
    "fast ingest ping reports server progress and end excludes its end marker from message count",
    () =>
      withBroker(
        Effect.gen(function*() {
          const client = yield* JetStreamClient.JetStreamClient
          const manager = yield* JetStreamManager.JetStreamManager
          const ingest = yield* client.startFastIngest(`${subject}.ingest`, "first", {
            allowGaps: false,
            ackInterval: 10
          })
          yield* ingest.add(`${subject}.ingest`, "second")
          expect((yield* ingest.ping(1000)).batchSeq).toBe(2)
          const ack = yield* ingest.end()
          expect(ack).toMatchObject({ stream: name, count: 2, batch: ingest.batch })
          expect((yield* manager.streams.info(name)).state.messages).toBe(2)
        })
      ),
    { timeout: 30_000 }
  )

  it.live("fast ingest rejects a stream without batched publishing support", () =>
    withBroker(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.streams.add({ name: "NO_BATCH", subjects: ["no.batch"], storage: StorageType.Memory })
        const error = yield* client.startFastIngest("no.batch", "first", { allowGaps: false, ackInterval: 5 }).pipe(
          Effect.flip
        )
        expect(error._tag).toBe("JetStreamClientError")
        expect((yield* manager.streams.info("NO_BATCH")).state.messages).toBe(0)
      })
    ), { timeout: 30_000 })

  it.live("scheduled single-shot publishing delivers the target message to a pull consumer", () =>
    withBroker(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, {
          durable_name: "scheduled",
          ack_policy: AckPolicy.None,
          filter_subject: `${subject}.target`
        })
        const now = yield* DateTime.now
        yield* client.publish(`${subject}.schedule`, "scheduled payload", {
          schedule: {
            specification: { at: DateTime.formatIso(DateTime.addDuration(now, "500 millis")) },
            target: `${subject}.target`
          }
        })
        const consumer = yield* client.consumers.get(name, "scheduled")
        const message = Option.getOrThrow(yield* consumer.next({ expires: 3000 }))
        expect(message.subject).toBe(`${subject}.target`)
        expect(message.string()).toBe("scheduled payload")
      })
    ), { timeout: 30_000 })

  it.live("scheduled interval publishing delivers repeated target messages", () =>
    withBroker(
      Effect.gen(function*() {
        const client = yield* JetStreamClient.JetStreamClient
        const manager = yield* JetStreamManager.JetStreamManager
        yield* manager.consumers.add(name, {
          durable_name: "interval",
          ack_policy: AckPolicy.None,
          filter_subject: `${subject}.target`
        })
        yield* client.publish(`${subject}.schedule`, "tick", {
          schedule: { specification: { every: "1s" }, target: `${subject}.target`, ttl: "5m" }
        })
        const consumer = yield* client.consumers.get(name, "interval")
        const first = Option.getOrThrow(yield* consumer.next({ expires: 3000 }))
        const second = Option.getOrThrow(yield* consumer.next({ expires: 3000 }))
        expect([first.string(), second.string()]).toEqual(["tick", "tick"])
        expect(second.seq).toBeGreaterThan(first.seq)
      })
    ), { timeout: 30_000 })
})
