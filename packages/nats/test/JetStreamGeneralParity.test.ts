import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Option, Schedule, Stream } from "effect"
import type * as Scope from "effect/Scope"
import * as Client from "../src/JetStreamClient.ts"
import * as Manager from "../src/JetStreamManager.ts"
import type * as T from "../src/JetStreamTypes.ts"
import { AckPolicy, RetentionPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as Headers from "../src/NATSHeaders.ts"
import * as Node from "../src/NATSNodeConnection.ts"
import { makeCluster } from "./cluster.ts"
import { makeServer } from "./server.ts"

const fixture = (config: Partial<T.StreamConfig> = {}) =>
  Effect.gen(function*() {
    const server = yield* makeServer()
    const connection = yield* Node.make({ servers: server.url })
    const client = Client.make(connection)
    const manager = Manager.make(connection)
    yield* manager.streams.add({ name: "A", subjects: ["a", "b"], storage: StorageType.Memory, ...config })
    return { server, connection, client, manager }
  })
const ready = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }))
const count = (manager: Manager.JetStreamManager, name: string, expected: number) =>
  ready(
    manager.streams.info(name).pipe(Effect.flatMap((info) =>
      info.state.messages === expected
        ? Effect.succeed(info) :
        Effect.fail(new Error(`Expected ${expected}, received ${info.state.messages}`))
    ))
  )
const run = <A, E>(name: string, effect: Effect.Effect<A, E, Scope.Scope>) =>
  it.live(name, () => effect.pipe(Effect.scoped), { timeout: 40_000 })

describe("official general JetStream application laws", () => {
  for (
    const [name, options, expected] of [
      ["jetstream - default options", {}, { apiPrefix: "$JS.API", timeout: 5000 }],
      ["jetstream - default override timeout", { timeout: 1000 }, { apiPrefix: "$JS.API", timeout: 1000 }],
      ["jetstream - default override prefix", { apiPrefix: "$XX.API" }, { apiPrefix: "$XX.API", timeout: 5000 }],
      ["jetstream - options removes trailing dot", { apiPrefix: "$XX.API." }, { apiPrefix: "$XX.API", timeout: 5000 }]
    ] satisfies Array<[string, T.JetStreamOptions, T.JetStreamOptions]>
  ) {
    run(
      name,
      Effect.gen(function*() {
        const { connection } = yield* fixture()
        expect(yield* Client.make(connection, options).options).toMatchObject(expected)
        expect(yield* Manager.make(connection, options).options).toMatchObject(expected)
      })
    )
  }
  run(
    "jetstream - options rejects empty prefix",
    Effect.gen(function*() {
      const { connection } = yield* fixture()
      expect((yield* Client.make(connection, { apiPrefix: "" }).options.pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* Manager.make(connection, { apiPrefix: "" }).options.pipe(Effect.result))._tag).toBe("Failure")
    })
  )
  run(
    "jetstream - find stream throws when not found",
    Effect.gen(function*() {
      const { manager } = yield* fixture()
      expect((yield* manager.streams.find("hello").pipe(Effect.flip)).reason).toContain("hello")
    })
  )
  run(
    "jetstream - publish basic",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      expect(yield* client.publish("a")).toMatchObject({ stream: "A", seq: 1, duplicate: false })
      expect(yield* client.publish("a")).toMatchObject({ stream: "A", seq: 2, duplicate: false })
    })
  )
  run(
    "jetstream - publish id",
    Effect.gen(function*() {
      const { client, manager } = yield* fixture()
      yield* client.publish("a", "", { msgID: "a" })
      expect(Option.getOrThrow(yield* manager.streams.getMessage("A", { seq: 1 })).header.get("Nats-Msg-Id")).toBe("a")
    })
  )
  run(
    "jetstream - publish require stream",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      expect((yield* client.publish("a", "", { expect: { streamName: "wrong" } }).pipe(Effect.result))._tag).toBe(
        "Failure"
      )
      expect(yield* client.publish("a", "", { expect: { streamName: "A" } })).toMatchObject({
        seq: 1,
        duplicate: false
      })
    })
  )
  run(
    "jetstream - publish require last message id",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      yield* client.publish("a", "", { msgID: "a" })
      expect((yield* client.publish("a", "", { expect: { lastMsgID: "b" } }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* client.publish("a", "", { msgID: "b", expect: { lastMsgID: "a" } })).toMatchObject({ seq: 2 })
    })
  )
  run(
    "jetstream - get message last by subject",
    Effect.gen(function*() {
      const { client, manager } = yield* fixture()
      for (const [subject, payload] of [["a", "a"], ["a", "aa"], ["b", "b"], ["b", "bb"]]) {
        yield* client.publish(subject, payload)
      }
      expect(yield* Option.getOrThrow(yield* manager.streams.getMessage("A", { last_by_subj: "a" })).string).toBe("aa")
    })
  )
  for (const name of ["jetstream - publish first sequence", "jetstream - publish require last sequence"]) {
    run(
      name,
      Effect.gen(function*() {
        const { client } = yield* fixture()
        expect(yield* client.publish("a", "", { expect: { lastSequence: 0 } })).toMatchObject({ seq: 1 })
        for (const lastSequence of [0, 2]) {
          expect((yield* client.publish("a", "", { expect: { lastSequence } }).pipe(Effect.result))._tag).toBe(
            "Failure"
          )
        }
        expect(yield* client.publish("a", "", { expect: { lastSequence: 1 } })).toMatchObject({ seq: 2 })
      })
    )
  }
  run(
    "jetstream - publish require last sequence by subject",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      yield* client.publish("a")
      yield* client.publish("b")
      expect(yield* client.publish("a", "", { expect: { lastSubjectSequence: 1 } })).toMatchObject({ seq: 3 })
      for (let index = 0; index < 100; index++) yield* client.publish("b")
      expect(yield* client.publish("a", "", { expect: { lastSubjectSequence: 3 } })).toMatchObject({ seq: 104 })
    })
  )
  run(
    "jetstream - last subject sequence subject",
    Effect.gen(function*() {
      const { client } = yield* fixture({ subjects: ["a.>"], max_msgs_per_subject: 1 })
      for (
        const subject of ["a.1.foo", "a.1.bar", "a.2.foo", "a.3.bar", "a.1.baz", "a.1.bar", "a.2.baz"]
      ) yield* client.publish(subject)
      const cases: Array<[string, string, number, boolean]> = [
        ["a.1.foo", "a.1.*", 0, false],
        ["a.1.bar", "a.1.*", 0, false],
        ["a.1.xxx", "a.1.*", 0, false],
        ["a.1.foo", "a.1.*", 1, false],
        ["a.1.bar", "a.1.*", 1, false],
        ["a.1.xxx", "a.1.*", 1, false],
        ["a.2.foo", "a.2.*", 1, false],
        ["a.2.bar", "a.2.*", 1, false],
        ["a.2.xxx", "a.2.*", 1, false],
        ["a.1.bar", "a.1.*", 3, false],
        ["a.1.bar", "a.1.*", 4, false],
        ["a.1.bar", "a.1.*", 5, false],
        ["a.1.bar", "a.1.*", 6, true],
        ["a.1.baz", "a.1.*", 2, false],
        ["a.1.bar", "a.1.*", 7, false],
        ["a.1.xxx", "a.1.*", 8, true],
        ["a.2.foo", "a.2.*", 2, false],
        ["a.2.foo", "a.2.*", 7, true],
        ["a.xxx", "a.*", 0, true],
        ["a.xxx", "a.*.*", 0, false],
        ["a.3.xxx", "a.3.*", 4, true],
        ["a.3.xyz", "a.3.*", 12, true]
      ]
      for (const [subject, lastSubjectSequenceSubject, lastSubjectSequence, success] of cases) {
        const result = yield* client.publish(subject, "", {
          expect: { lastSubjectSequenceSubject, lastSubjectSequence }
        }).pipe(Effect.result)
        expect(result._tag === "Success", JSON.stringify([subject, lastSubjectSequenceSubject, lastSubjectSequence]))
          .toBe(success)
      }
    })
  )
  run(
    "jetstream - ephemeral options",
    Effect.gen(function*() {
      const { manager } = yield* fixture()
      expect((yield* manager.consumers.add("A", { inactive_threshold: 1_000_000_000 })).config.inactive_threshold).toBe(
        1_000_000_000
      )
    })
  )
  run(
    "jetstream - publish headers",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      const headers = Headers.headers()
      headers.set("a", "b")
      yield* client.publish("a", "", { headers })
      const consumer = yield* client.consumers.get("A")
      expect(Option.getOrThrow(Option.getOrThrow(yield* consumer.next()).headers).get("a")).toBe("b")
    })
  )
  for (const name of ["jetstream - JSON", "jetstream - jsmsg decode"]) {
    run(
      name,
      Effect.gen(function*() {
        const { client } = yield* fixture()
        const encoded = [
          "null",
          "true",
          "\"\"",
          "[\"hello\"]",
          "{\"hello\":\"world\"}",
          "{\"one\":\"two\",\"a\":[1,2,3]}"
        ]
        for (const text of encoded) yield* client.publish("a", text)
        const consumer = yield* client.consumers.get("A")
        for (const text of encoded) {
          const message = Option.getOrThrow(yield* consumer.next())
          expect(message.string()).toBe(text)
          expect(yield* message.json()).toEqual(JSON.parse(text))
        }
      })
    )
  }
  for (const name of ["jetstream - domain", "jetstream - account domain", "jetstream - puback domain"]) {
    run(
      name,
      Effect.gen(function*() {
        const account = name === "jetstream - account domain"
        const server = yield* makeServer({
          jetstream: false,
          config: `jetstream { store_dir: /tmp/jetstream, domain: A }\n${
            account
              ? "accounts { A { users: [{ user: a, password: a }], jetstream { max_memory: 10000, max_file: 10000 } } }"
              : ""
          }`
        })
        const connection = yield* Node.make({ servers: server.url, ...(account ? { user: "a", pass: "a" } : {}) })
        const manager = Manager.make(connection, { domain: "A" })
        const client = Client.make(connection, { domain: "A" })
        expect((yield* manager.accountInfo).domain).toBe("A")
        expect(client.apiPrefix).toBe("$JS.A.API")
        yield* manager.streams.add({ name: "A", subjects: ["a"], storage: StorageType.Memory })
        expect((yield* client.publish("a")).domain).toBe("A")
      })
    )
  }
  run(
    "jetstream - source",
    Effect.gen(function*() {
      const { client, manager, connection } = yield* fixture()
      for (let index = 0; index < 10; index++) {
        yield* client.publish("a")
        yield* client.publish("b")
      }
      yield* manager.streams.add({
        name: "WORK",
        retention: RetentionPolicy.Workqueue,
        sources: [{ name: "A", filter_subject: ">" }],
        storage: StorageType.Memory
      })
      yield* count(manager, "WORK", 20)
      yield* manager.consumers.add("WORK", { durable_name: "B", filter_subject: "b", ack_policy: AckPolicy.Explicit })
      const consumer = yield* client.consumers.get("WORK", "B")
      const messages = yield* consumer.fetch({ max_messages: 10, expires: 1000 })
      yield* messages.stream.pipe(Stream.runForEach((message) => message.ackAck()))
      yield* connection.flush
      expect((yield* count(manager, "WORK", 10)).state.messages).toBe(10)
    })
  )
  for (
    const [name, mode] of [["jetstream - seal", "seal"], ["jetstream - deny delete", "deny delete"], [
      "jetstream - deny purge",
      "deny purge"
    ]] as const
  ) {
    run(
      name,
      Effect.gen(function*() {
        const { client, manager } = yield* fixture(
          mode === "deny delete" ? { deny_delete: true } : mode === "deny purge" ? { deny_purge: true } : {}
        )
        yield* client.publish("a")
        yield* client.publish("a")
        if (mode === "seal") {
          expect((yield* manager.streams.info("A")).config.sealed).toBe(false)
          expect(yield* manager.streams.deleteMessage("A", 1)).toBe(true)
          expect((yield* manager.streams.update("A", { sealed: true })).config.sealed).toBe(true)
        }
        const error = mode === "deny purge"
          ? yield* manager.streams.purge("A").pipe(Effect.flip)
          : yield* manager.streams.deleteMessage("A", 2).pipe(Effect.flip)
        expect(error.reason).toContain(mode === "seal" ? "sealed" : "not permitted")
      })
    )
  }
  for (
    const [name, mode] of [["jetstream - rollup all", "all"], ["jetstream - rollup subject", "subject"], [
      "jetstream - no rollup",
      "no rollup"
    ]] as const
  ) {
    run(
      name,
      Effect.gen(function*() {
        const { client, manager } = yield* fixture({ allow_rollup_hdrs: mode !== "no rollup" })
        for (let index = 0; index < 10; index++) {
          yield* client.publish("a")
          if (mode === "subject") yield* client.publish("b")
        }
        if (mode === "subject") {
          expect((yield* manager.consumers.add("A", { durable_name: "existing", filter_subject: "a" })).num_pending)
            .toBe(10)
        }
        const headers = Headers.headers()
        headers.set("Nats-Rollup", mode === "all" ? "all" : "sub")
        if (mode === "no rollup") {
          expect((yield* client.publish("a", "42", { headers }).pipe(Effect.flip)).reason).toContain("rollup")
        } else {
          yield* client.publish("a", "42", { headers })
          expect((yield* manager.streams.info("A")).state.messages).toBe(mode === "all" ? 1 : 11)
          if (mode === "subject") {
            expect((yield* manager.consumers.info("A", "existing")).num_pending).toBe(1)
            for (const [subject, expected] of [["a", 1], ["b", 10]] satisfies Array<[string, number]>) {
              expect((yield* manager.consumers.add("A", { filter_subject: subject })).num_pending).toBe(expected)
            }
          }
        }
      })
    )
  }
  for (const [name, mode] of [["jetstream - backoff", "backoff"], ["jetstream - redelivery", "redelivery"]] as const) {
    run(
      name,
      Effect.gen(function*() {
        const { client, manager } = yield* fixture()
        const backoff = [250_000_000, 1_000_000_000, 3_000_000_000]
        const config = yield* manager.consumers.add("A", {
          durable_name: "C",
          ack_policy: AckPolicy.Explicit,
          max_deliver: 4,
          ...(mode === "backoff" ? { backoff } : { ack_wait: 1_000_000_000 })
        })
        if (mode === "backoff") expect(config.config.backoff).toEqual(backoff)
        yield* client.publish("a")
        const consumer = yield* client.consumers.get("A", "C")
        const messages = yield* consumer.consume({ max_messages: 1, expires: 5000 })
        const received = yield* messages.stream.pipe(
          Stream.take(4),
          Stream.mapEffect((message) =>
            Effect.map(
              Clock.currentTimeMillis,
              (time) => ({ time, info: message.info, redelivered: message.redelivered })
            )
          ),
          Stream.runCollect,
          Effect.timeout("10 seconds")
        )
        expect(received.map((entry) => entry.info.deliveryCount)).toEqual([1, 2, 3, 4])
        expect(received.map((entry) => entry.redelivered)).toEqual([false, true, true, true])
        if (mode === "backoff") {
          for (let index = 1; index < 4; index++) {
            expect(Math.abs(received[index].time - received[index - 1].time - backoff[index - 1] / 1_000_000))
              .toBeLessThan(100)
          }
        }
      })
    )
  }
  run(
    "jetstream - detailed errors",
    Effect.gen(function*() {
      const { manager } = yield* fixture()
      const error = yield* manager.streams.add({ name: "BAD", subjects: ["bad"], num_replicas: 3 }).pipe(Effect.flip)
      expect(error.apiError).toMatchObject({
        code: 500,
        err_code: 10074,
        description: "replicas > 1 not supported in non-clustered mode"
      })
    })
  )
  run(
    "jetstream - repub on 503",
    Effect.gen(function*() {
      const servers = yield* makeCluster
      const connection = yield* Node.make({
        servers: servers.map((server) => server.url),
        // Docker gossip advertises bridge addresses; the host reaches the mapped seeds.
        ignoreClusterUpdates: true,
        reconnectTimeWait: 10,
        reconnectJitter: 0
      })
      const manager = Manager.make(connection)
      const client = Client.make(connection)
      const info = yield* ready(
        manager.streams.add({ name: "A", subjects: ["a"], num_replicas: 3, storage: StorageType.Memory })
      )
      const leader = servers.find((server) => server.name === info.cluster?.leader)
      if (leader === undefined) return yield* Effect.fail(new Error("Fixture leader is missing"))
      yield* client.publish("a")
      yield* leader.stop
      expect((yield* client.publish("a", "", { retries: 15, timeout: 1000 })).seq).toBe(2)
      expect((yield* manager.streams.info("A")).state.messages).toBe(2)
    })
  )
  run(
    "jetstream - duplicate message pub",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      expect((yield* client.publish("a", "", { msgID: "x" })).duplicate).toBe(false)
      expect((yield* client.publish("a", "", { msgID: "x" })).duplicate).toBe(true)
    })
  )
  run(
    "jetstream - republish",
    Effect.gen(function*() {
      const { connection, manager } = yield* fixture({ republish: { src: "a", dest: "republished" } })
      expect((yield* manager.streams.info("A")).config.republish).toMatchObject({ src: "a", dest: "republished" })
      const sub = yield* connection.subscribe("republished", { max: 1 })
      yield* connection.publish("a", "message")
      const message = Option.getOrThrow(yield* sub.stream.pipe(Stream.runHead, Effect.timeout("2 seconds")))
      const header = Option.getOrThrow(message.headers)
      expect([
        header.get("Nats-Subject"),
        header.get("Nats-Sequence"),
        header.get("Nats-Stream"),
        header.get("Nats-Last-Sequence")
      ]).toEqual(["a", "1", "A", "0"])
    })
  )
  run(
    "jetstream - num_replicas consumer option",
    Effect.gen(function*() {
      const { manager } = yield* fixture()
      expect((yield* manager.streams.info("A")).config.num_replicas).toBe(1)
      expect((yield* manager.consumers.add("A", { num_replicas: 3 }).pipe(Effect.flip)).reason).toContain("replicas")
    })
  )
  run(
    "jetstream - filter_subject consumer update",
    Effect.gen(function*() {
      const { manager } = yield* fixture()
      yield* manager.consumers.add("A", { durable_name: "C", filter_subject: "a" })
      expect((yield* manager.consumers.update("A", "C", { filter_subject: "b" })).config.filter_subject).toBe("b")
    })
  )
  run(
    "jetstream - input transform",
    Effect.gen(function*() {
      const { client, manager } = yield* fixture({ subject_transform: { src: ">", dest: "transformed.>" } })
      yield* client.publish("a")
      expect(Option.getOrThrow(yield* manager.streams.getMessage("A", { seq: 1 })).subject).toBe("transformed.a")
    })
  )
  run(
    "jetstream - source transforms",
    Effect.gen(function*() {
      const { client, manager } = yield* fixture({ subjects: ["a"] })
      for (const name of ["B", "C"]) {
        yield* manager.streams.add({ name, subjects: [name.toLowerCase()], storage: StorageType.Memory })
      }
      for (const subject of ["a", "b", "c"]) {
        yield* client.publish(subject)
      }
      yield* manager.streams.add({
        name: "SOURCED",
        sources: [{ name: "A", subject_transforms: [{ src: ">", dest: "transformed.>" }] }, { name: "B" }, {
          name: "C"
        }],
        storage: StorageType.Memory
      })
      yield* count(manager, "SOURCED", 3)
      const consumer = yield* client.consumers.get("SOURCED")
      const messages = yield* consumer.fetch({ max_messages: 3 })
      expect((yield* messages.stream.pipe(Stream.map((message) => message.subject), Stream.runCollect)).sort()).toEqual(
        ["b", "c", "transformed.a"]
      )
    })
  )
  run(
    "jetstream - term reason",
    Effect.gen(function*() {
      const { client, manager } = yield* fixture()
      const watching = yield* manager.advisoryStream.pipe(
        Stream.filter((advisory) => advisory.kind === "terminated"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true })
      )
      yield* client.publish("a")
      yield* manager.consumers.add("A", { durable_name: "C", ack_policy: AckPolicy.Explicit })
      const consumer = yield* client.consumers.get("A", "C")
      yield* Option.getOrThrow(yield* consumer.next()).term("requested termination")
      expect(Option.getOrThrow(yield* Fiber.join(watching).pipe(Effect.timeout("2 seconds"))).data).toMatchObject({
        type: "io.nats.jetstream.advisory.v1.terminated",
        reason: "requested termination"
      })
    })
  )
  run(
    "jetstream - publish no responder",
    Effect.gen(function*() {
      const { client } = yield* fixture()
      expect((yield* client.publish("missing").pipe(Effect.flip)).cause).toMatchObject({ code: "no_responders" })
      const server = yield* makeServer({ jetstream: false })
      const connection = yield* Node.make({ servers: server.url })
      expect((yield* Client.make(connection).publish("a").pipe(Effect.flip)).cause).toMatchObject({
        code: "no_responders"
      })
    })
  )
  run(
    "jetstream - watcherPrefix",
    Effect.gen(function*() {
      const { connection, server } = yield* fixture()
      expect((yield* Client.make(connection).options).watcherPrefix).toBeUndefined()
      expect((yield* Manager.make(connection).options).watcherPrefix).toBeUndefined()
      const prefixed = yield* Node.make({ servers: server.url, inboxPrefix: "hello" })
      for (
        const [options, expected] of [[{}, "hello"], [{ watcherPrefix: "bar" }, "bar"]] satisfies Array<
          [T.JetStreamOptions, string]
        >
      ) {
        const client = Client.make(prefixed, options)
        expect((yield* client.options).watcherPrefix).toBe(expected)
        const manager = yield* client.jetstreamManager()
        expect((yield* manager.options).watcherPrefix).toBe(expected)
        expect((yield* (yield* manager.jetstream).options).watcherPrefix).toBe(expected)
      }
      expect((yield* Client.make(prefixed, { watcherPrefix: "hello.*" }).options.pipe(Effect.result))._tag).toBe(
        "Failure"
      )
      expect((yield* Manager.make(connection, { watcherPrefix: "hello.*" }).options.pipe(Effect.result))._tag).toBe(
        "Failure"
      )
    })
  )
  run(
    "jetstream - watcher deliver_subject",
    Effect.gen(function*() {
      const { connection, server } = yield* fixture()
      const prefixed = yield* Node.make({ servers: server.url, inboxPrefix: "hallo" })
      for (
        const [client, expected] of [[Client.make(connection), "_INBOX"], [Client.make(prefixed), "hallo"], [
          Client.make(prefixed, { watcherPrefix: "hola" }),
          "hola"
        ]] as const
      ) {
        const consumer = yield* client.consumers.getPushConsumer("A")
        expect((yield* consumer.info()).config.deliver_subject?.split(".")[0]).toBe(expected)
        yield* consumer.delete
      }
    })
  )
  run(
    "jetstream - base client timeout",
    Effect.gen(function*() {
      const { connection } = yield* fixture()
      yield* connection.subscribe("silent.>")
      yield* connection.flush
      for (const timeout of [5000, 500]) {
        const client = Client.make(connection, { apiPrefix: "silent", ...(timeout === 5000 ? {} : { timeout }) })
        const operations: Array<Effect.Effect<unknown, { readonly reason: string }>> = [
          client.publish("silent.publish", "", { retries: 1 }),
          client.streams.get("ignored")
        ]
        for (const operation of operations) {
          const start = yield* Clock.currentTimeMillis
          const error = yield* operation.pipe(Effect.flip)
          expect(error.reason.toLowerCase()).toContain("timed out")
          const elapsed = (yield* Clock.currentTimeMillis) - start
          expect(elapsed).toBeGreaterThanOrEqual(timeout - 50)
          expect(elapsed).toBeLessThan(timeout + 500)
        }
      }
    })
  )
  run(
    "jetstream - jsm base timeout",
    Effect.gen(function*() {
      const { connection } = yield* fixture()
      yield* connection.subscribe("silent.>")
      yield* connection.flush
      for (const timeout of [5000, 500]) {
        const manager = Manager.make(connection, {
          apiPrefix: "silent",
          checkAPI: false,
          ...(timeout === 5000 ? {} : { timeout })
        })
        const start = yield* Clock.currentTimeMillis
        const error = yield* manager.accountInfo.pipe(Effect.flip)
        expect(error.reason.toLowerCase()).toContain("timed out")
        const elapsed = (yield* Clock.currentTimeMillis) - start
        expect(elapsed).toBeGreaterThanOrEqual(timeout - 50)
        expect(elapsed).toBeLessThan(timeout + 500)
      }
    })
  )
})
