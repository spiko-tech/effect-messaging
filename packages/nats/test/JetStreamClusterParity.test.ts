import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Queue, Schedule, Stream } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import { AckPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import { makeCluster } from "./cluster.ts"

const name = "CLUSTER_PARITY"
const subject = "native.cluster.parity"
const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 })
  )

describe("Three-node JetStream cluster parity", () => {
  it.live("durable pull consumption resumes after the stream leader is stopped", () =>
    Effect.gen(function*() {
      const servers = yield* makeCluster
      const connection = NATSConnection.layerNode({
        servers: servers.map((server) => server.url),
        // Docker gossip advertises bridge addresses; the host reaches the mapped seeds.
        ignoreClusterUpdates: true,
        noRandomize: true,
        reconnectTimeWait: 10,
        reconnectJitter: 0,
        maxReconnectAttempts: 100
      })
      const services = JetStreamClient.layer().pipe(
        Layer.provideMerge(JetStreamManager.layer({ checkAPI: false })),
        Layer.provideMerge(connection)
      )
      yield* Effect.gen(function*() {
        const manager = yield* JetStreamManager.JetStreamManager
        const client = yield* JetStreamClient.JetStreamClient
        yield* ready(manager.accountInfo)
        const created = yield* ready(manager.streams.add({
          name,
          subjects: [subject],
          storage: StorageType.Memory,
          num_replicas: 3
        }))
        yield* manager.streams.add({
          name: `${name}_MIRROR`,
          mirror: { name },
          storage: StorageType.Memory,
          num_replicas: 3
        })
        const wrapper = yield* client.streams.get(name)
        const alternates = yield* ready(wrapper.alternates.pipe(Effect.flatMap((values) =>
          values.length === 2 ? Effect.succeed(values) : Effect.fail(new Error("Mirror alternate is not ready"))
        )))
        expect(
          alternates.map((value) =>
            value.name
          ).sort()
        ).toEqual([name, `${name}_MIRROR`].sort())
        expect([name, `${name}_MIRROR`]).toContain((yield* wrapper.best).name)
        expect(yield* manager.streams.leaderStepdown(name)).toBe(true)
        const steppedDown = yield* ready(
          manager.streams.info(name).pipe(Effect.flatMap((info) =>
            info.cluster?.leader && info.cluster.leader !== created.cluster?.leader
              ? Effect.succeed(info) :
              Effect.fail(new Error("Stream leadership has not changed"))
          ))
        )
        const originalLeader = steppedDown.cluster?.leader
        expect(originalLeader).toBeDefined()
        const leader = servers.find((server) =>
          server.name === originalLeader
        )
        expect(leader).toBeDefined()
        if (leader === undefined) return yield* Effect.fail(new Error("Stream leader is absent from fixture cluster"))
        yield* manager.consumers.add(name, { durable_name: "durable", ack_policy: AckPolicy.Explicit })
        const consumer = yield* client.consumers.get(name, "durable")
        const iterator = yield* consumer.consume({ max_messages: 1, expires: 1000 })
        const consumed = yield* Queue.unbounded<string>()
        const running = yield* iterator.stream.pipe(
          Stream.take(3),
          Stream.runForEach((message) =>
            message.ackAck().pipe(Effect.andThen(Queue.offer(consumed, message.string())))
          ),
          Effect.forkChild
        )
        const received = Queue.take(consumed).pipe(Effect.raceFirst(
          Fiber.join(running).pipe(Effect.andThen(Effect.never))
        ))
        yield* client.publish(subject, "before leader loss")
        expect(yield* received).toBe("before leader loss")
        yield* ready(
          manager.streams.info(`${name}_MIRROR`).pipe(
            Effect.flatMap((info) =>
              info.state.messages === 1 ? Effect.void : Effect.fail(new Error("Initial mirror delivery is not ready"))
            )
          )
        )
        yield* leader.stop
        yield* ready(
          manager.streams.info(name).pipe(Effect.flatMap((info) =>
            info.cluster?.leader !== undefined && info.cluster.leader !== originalLeader
              ? Effect.void :
              Effect.fail(new Error("Replacement stream leader is not ready"))
          ))
        )
        yield* client.publish(subject, "after leader loss one", { retries: 5 })
        yield* client.publish(subject, "after leader loss two", { retries: 5 })
        expect(yield* received).toBe("after leader loss one")
        expect(yield* received).toBe("after leader loss two")
        yield* Fiber.join(running)
        expect((yield* manager.streams.info(name)).state.messages).toBe(3)
        const removal = yield* manager.streams.removePeer(name, leader.name).pipe(Effect.flip)
        expect(removal._tag).toBe("JetStreamStreamAPIError")
        expect(removal.reason).toContain("peer remap failed")
        let mirrorState = "No mirror INFO response received"
        // The server's internal mirror consumer must rebind after source leadership changes. Give that broker-owned
        // recovery a bounded deadline independently of the client pull consumer's faster reconnect assertion above.
        const mirror = yield* manager.streams.info(`${name}_MIRROR`).pipe(
          Effect.tap((info) =>
            Effect.sync(() => {
              mirrorState = JSON.stringify({
                messages: info.state.messages,
                lag: info.mirror?.lag,
                active: info.mirror?.active,
                leader: info.cluster?.leader,
                sourceError: info.mirror?.error
              })
            })
          ),
          Effect.flatMap((info) =>
            info.state.messages === 3 ? Effect.succeed(info) : Effect.fail(new Error("Mirror has not caught up"))
          ),
          Effect.retry(Schedule.spaced("100 millis")),
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error("Mirror did not recover after source leader loss: " + mirrorState))
          })
        )
        expect(mirror.mirror?.name).toBe(name)
        expect((yield* manager.consumers.info(name, "durable")).ack_floor.stream_seq).toBe(3)
      }).pipe(Effect.scoped, Effect.provide(services))
    }).pipe(Effect.scoped), { timeout: 60_000 })
})
