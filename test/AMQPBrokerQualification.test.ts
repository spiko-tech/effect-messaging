import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Queue, Redacted, Stream } from "effect"
import type * as AMQPConsumeMessage from "../packages/amqp/src/AMQPConsumeMessage.ts"
import * as AMQPTypes from "../packages/amqp/src/AMQPTypes.ts"
import { expectFailure } from "../packages/amqp/test/assertions.ts"
import { makeBrokerInfrastructure, makeConfirmLossProxy } from "../packages/amqp/test/brokerInfrastructure.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (content: Uint8Array) => new TextDecoder().decode(content)

describe("owned RabbitMQ 4.3.6 broker qualification", () => {
  it.live(
    "persistent classic and quorum messages survive actual container stop/start; stale deliveries cannot settle redelivery",
    () =>
      Effect.gen(function*() {
        const broker = yield* makeBrokerInfrastructure()
        const connection = yield* broker.connect()
        const channel = yield* connection.createChannel({ confirm: true })
        const queues = []
        for (const type of ["classic", "quorum"]) {
          const queue = yield* channel.assertQueue(`durable-${type}`, {
            durable: true,
            arguments: { "x-queue-type": type }
          })
          queues.push(queue)
          yield* channel.sendToQueue(queue, encode(type), { persistent: true, messageId: type, headers: {} })
        }
        const stale = yield* channel.get(queues[0])
        expect(Option.isSome(stale)).toBe(true)
        yield* broker.stop()
        yield* broker.start()
        const recovered = yield* broker.connect()
        const fresh = yield* recovered.createChannel({ confirm: true })
        for (const [index, queue] of queues.entries()) {
          const result = yield* fresh.get(queue)
          expect(Option.isSome(result)).toBe(true)
          if (Option.isNone(result)) return yield* Effect.die("Persistent message disappeared after restart")
          expect(decode(result.value.content)).toBe(index === 0 ? "classic" : "quorum")
          expect(result.value.properties.deliveryMode).toBe(2)
          expect(result.value.fields.redelivered).toBe(index === 0)
          if (index === 0 && Option.isSome(stale)) {
            expect(Exit.isFailure(yield* Effect.exit(channel.ack(stale.value)))).toBe(true)
            expect(Exit.isFailure(yield* Effect.exit(fresh.ack(stale.value)))).toBe(true)
          }
          yield* fresh.ack(result.value)
          expect(yield* fresh.get(queue)).toEqual(Option.none())
        }
      }).pipe(Effect.scoped),
    360000
  )

  it.live(
    "actual broker confirmation loss is Unknown, and recovery never replays an already accepted publish",
    () =>
      Effect.gen(function*() {
        const broker = yield* makeBrokerInfrastructure()
        const proxy = yield* makeConfirmLossProxy(broker.nodes[0].port)
        const connection = yield* broker.connect(0, { port: proxy.port, heartbeat: 0 })
        const channel = yield* connection.createChannel({ confirm: true, confirmTimeout: "500 millis" })
        const controlConnection = yield* broker.connect()
        const control = yield* controlConnection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("confirm-loss", { durable: true })
        yield* proxy.dropBrokerBytes
        expectFailure(
          yield* Effect.exit(channel.sendToQueue(queue, encode("accepted-with-lost-confirm"), {
            persistent: true,
            messageId: "ambiguous-once",
            headers: {}
          })),
          { _tag: "AMQPPublishError", outcome: "Unknown" }
        )
        const accepted = yield* control.get(queue)
        expect(Option.isSome(accepted)).toBe(true)
        if (Option.isNone(accepted)) return yield* Effect.die("Broker did not accept the ambiguous publish")
        expect(decode(accepted.value.content)).toBe("accepted-with-lost-confirm")
        yield* control.ack(accepted.value)
        yield* proxy.restoreBrokerBytes
        yield* connection.reconnect
        yield* channel.sendToQueue(queue, encode("recovery-barrier"), { messageId: "barrier", headers: {} })
        const barrier = yield* control.get(queue)
        expect(Option.isSome(barrier)).toBe(true)
        if (Option.isNone(barrier)) return yield* Effect.die("Recovery did not publish its barrier")
        expect(barrier.value.properties.messageId).toBe("barrier")
        yield* control.ack(barrier.value)
        expect(yield* control.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped),
    300000
  )

  it.live(
    "a three-node quorum retains confirmed data through leader shutdown and an actual minority network partition",
    () =>
      Effect.gen(function*() {
        const broker = yield* makeBrokerInfrastructure(3)
        const connection = yield* broker.connect()
        const channel = yield* connection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("failover", {
          durable: true,
          arguments: { "x-queue-type": "quorum", "x-quorum-initial-group-size": 3 }
        })
        yield* channel.sendToQueue(queue, encode("before-failover"), { persistent: true, headers: {} })
        yield* Effect.logInfo("Initial quorum membership", yield* broker.queueInfo(0, queue.queue))
        const info = yield* broker.poll(
          broker.queueInfo(0, queue.queue).pipe(Effect.flatMap((value) =>
            value.members?.length === 3 && value.leader !== undefined
              ? Effect.succeed(value)
              : Effect.fail("quorum not ready")
          ))
        )
        const leader = broker.nodes.findIndex((node) =>
          `rabbit@${node.hostname}` === info.leader
        )
        expect(leader).toBeGreaterThanOrEqual(0)
        const survivor = (leader + 1) % 3
        yield* broker.stop(leader)
        yield* Effect.logInfo("Stopped quorum leader", { leader: info.leader, survivor })
        yield* broker.poll(
          broker.queueInfo(survivor, queue.queue).pipe(Effect.flatMap((value) =>
            value.leader !== undefined && value.leader !== info.leader
              ? Effect.succeed(value)
              : Effect.fail("new leader not elected")
          ))
        )
        const survivingConnection = yield* broker.connect(survivor)
        const survivingChannel = yield* survivingConnection.createChannel({ confirm: true })
        yield* survivingChannel.sendToQueue(queue, encode("after-failover"), { persistent: true, headers: {} })
        yield* broker.start(leader)
        yield* broker.poll(broker.ctl(leader, "cluster_status"))
        const minority = yield* broker.connect(leader)
        const observingLoss = yield* Deferred.make<void>()
        const networkLoss = yield* minority.changes.pipe(
          Stream.tap(() =>
            Deferred.succeed(observingLoss, undefined)
          ),
          Stream.filter((state) => state.state === "Reconnecting"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* Deferred.await(observingLoss)
        yield* broker.isolate(leader)
        yield* Effect.logInfo("Disconnected former quorum leader from owned network")
        expect((yield* Fiber.join(networkLoss)).length).toBe(1)
        yield* survivingChannel.sendToQueue(queue, encode("during-partition"), { persistent: true, headers: {} })
        yield* broker.heal(leader)
        yield* broker.poll(broker.api(leader, "overview"))
        for (const text of ["before-failover", "after-failover", "during-partition"]) {
          const message = yield* survivingChannel.get(queue)
          expect(Option.isSome(message)).toBe(true)
          if (Option.isNone(message)) {
            return yield* Effect.die("Quorum lost a confirmed message")
          }
          expect(decode(message.value.content)).toBe(text)
          yield* survivingChannel.ack(message.value)
        }
        expect(yield* survivingChannel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped),
    600000
  )

  it.live(
    "broker-native mTLS validates trust, hostname, and client certificates; authentication and revoked ACLs fail",
    () =>
      Effect.gen(function*() {
        const broker = yield* makeBrokerInfrastructure()
        const connection = yield* broker.connect(0, { port: broker.nodes[0].tlsPort, tls: broker.tls })
        const channel = yield* connection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("tls-qualified", { durable: true })
        yield* channel.sendToQueue(queue, encode("mutually-authenticated"), { headers: {} })
        const message = yield* channel.get(queue)
        expect(Option.isSome(message)).toBe(true)
        if (Option.isSome(message)) yield* channel.ack(message.value)
        const amqplain = yield* broker.connect(0, { authentication: "AMQPLAIN" })
        const amqplainChannel = yield* amqplain.createChannel()
        yield* amqplainChannel.checkQueue(queue)
        const external = yield* broker.connect(0, {
          port: broker.nodes[0].tlsPort,
          tls: broker.tls,
          authentication: "EXTERNAL",
          username: "not-the-certificate-identity",
          password: Redacted.make("unused-password")
        })
        const externalChannel = yield* external.createChannel({ confirm: true })
        yield* externalChannel.sendToQueue(queue, encode("certificate-identity"), {
          userId: "review-client",
          headers: {}
        })
        const certificateMessage = yield* externalChannel.get(queue)
        expect(Option.isSome(certificateMessage)).toBe(true)
        if (Option.isSome(certificateMessage)) {
          expect(certificateMessage.value.properties.userId).toBe("review-client")
          yield* externalChannel.ack(certificateMessage.value)
        }
        for (
          const tls of [
            { ...broker.tls, servername: "wrong.invalid" },
            { ca: broker.tls.ca, servername: "localhost", rejectUnauthorized: true },
            { cert: broker.tls.cert, key: broker.tls.key, servername: "localhost", rejectUnauthorized: true }
          ]
        ) {
          expect(Exit.isFailure(yield* Effect.exit(broker.connect(0, { port: broker.nodes[0].tlsPort, tls })))).toBe(
            true
          )
        }
        expect(Exit.isFailure(yield* Effect.exit(broker.connect(0, { username: "missing-review-user" })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(broker.connect(0, { password: Redacted.make("invalid-password") }))))
          .toBe(true)
        yield* broker.ctl(0, "add_user", "guest", "guest")
        yield* broker.ctl(0, "set_permissions", "-p", "/", "guest", ".*", ".*", ".*")
        expect(
          Exit.isFailure(yield* Effect.exit(broker.connect(0, { username: "guest", password: Redacted.make("guest") })))
        ).toBe(true)
        yield* broker.api(0, "users/restricted", "PUT", { password: "qualification-only", tags: "" })
        yield* broker.api(0, "permissions/%2F/restricted", "PUT", {
          configure: "^allowed$",
          write: "^allowed$",
          read: "^allowed$"
        })
        const restricted = yield* broker.connect(0, {
          username: "restricted",
          password: Redacted.make("qualification-only")
        })
        const allowed = yield* restricted.createChannel()
        yield* allowed.assertQueue("allowed", { durable: true })
        const denied = yield* restricted.createChannel()
        expect(Exit.isFailure(yield* Effect.exit(denied.assertQueue("forbidden")))).toBe(true)
        yield* broker.api(0, "permissions/%2F/restricted", "DELETE")
        const revoked = yield* restricted.createChannel()
        expect(Exit.isFailure(yield* Effect.exit(revoked.get("allowed")))).toBe(true)
      }).pipe(Effect.scoped),
    360000
  )

  it.live(
    "RabbitMQ's real 60-second acknowledgement timeout closes a non-cancel-notifying channel and rejects stale settlement",
    () =>
      Effect.gen(function*() {
        const broker = yield* makeBrokerInfrastructure()
        const connection = yield* broker.connect(0, {
          clientProperties: { capabilities: { publisher_confirms: true, consumer_cancel_notify: false } }
        })
        const channel = yield* connection.createChannel({ confirm: true })
        const queue = yield* channel.assertQueue("ack-timeout", {
          durable: true,
          arguments: { "x-queue-type": "quorum", "x-consumer-timeout": AMQPTypes.fieldInteger("int32", 60000) }
        })
        const deliveries = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const stream = yield* channel.consume(queue, { prefetch: 1 })
        yield* stream.pipe(Stream.runForEach((message) => Queue.offer(deliveries, message)), Effect.forkChild)
        const timeout = yield* connection.changes.pipe(
          Stream.filter((state) => state.error?._tag === "AMQPChannelError" && state.error.replyCode === 406),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* channel.sendToQueue(queue, encode("ack-timeout-persistent"), { persistent: true, headers: {} })
        const original = yield* Queue.take(deliveries)
        expect(original.fields.redelivered).toBe(false)
        const [state] = yield* Fiber.join(timeout).pipe(
          Effect.timeout("150 seconds"),
          Effect.tapError(() => broker.logs().pipe(Effect.flatMap((logs) => Effect.logInfo(logs))))
        )
        expect(state.error?.reason).toMatch(/timed out.*acknowledgement|acknowledgement.*timed out/i)
        expect(Exit.isFailure(yield* Effect.exit(channel.ack(original)))).toBe(true)
        const redelivered = yield* Queue.take(deliveries)
        expect(redelivered.fields.redelivered).toBe(true)
        expect(decode(redelivered.content)).toBe("ack-timeout-persistent")
        yield* channel.ack(redelivered)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.timeout("240 seconds")),
    300000
  )

  for (const alarm of ["memory", "disk"]) {
    it.live(
      `actual ${alarm} alarm emits blocked/unblocked while a separate control connection remains usable`,
      () =>
        Effect.gen(function*() {
          const broker = yield* makeBrokerInfrastructure()
          const connection = yield* broker.connect()
          const channel = yield* connection.createChannel({ confirm: true })
          const controlConnection = yield* broker.connect()
          const control = yield* controlConnection.createChannel()
          const queue = yield* channel.assertQueue(`alarm-${alarm}`, { durable: true })
          yield* channel.sendToQueue(queue, encode("settle-during-alarm"), { headers: {} })
          const delivery = yield* control.get(queue)
          expect(Option.isSome(delivery)).toBe(true)
          const observing = yield* Deferred.make<void>()
          const blocked = yield* connection.changes.pipe(
            Stream.tap(() => Deferred.succeed(observing, undefined)),
            Stream.filter((change) => change.blocked !== undefined),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild
          )
          const unblocked = yield* connection.changes.pipe(
            Stream.dropWhile((change) => change.blocked === undefined),
            Stream.filter((change) => change.blocked === undefined),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild
          )
          yield* Deferred.await(observing)
          yield* broker.ctl(
            0,
            ...(alarm === "memory"
              ? ["set_vm_memory_high_watermark", "absolute", "1"]
              : ["set_disk_free_limit", "1000000000000000"])
          )
          yield* broker.poll(
            broker.alarms().pipe(Effect.flatMap((nodes) =>
              nodes.some((node) => alarm === "memory" ? node.mem_alarm : node.disk_free_alarm)
                ? Effect.void :
                Effect.fail("broker alarm not active")
            ))
          )
          const pending = yield* channel.sendToQueue(queue, encode("resume-after-alarm"), { headers: {} }).pipe(
            Effect.forkChild
          )
          expect((yield* Fiber.join(blocked)).length).toBe(1)
          yield* control.checkQueue(queue)
          if (Option.isSome(delivery)) {
            yield* control.ack(delivery.value)
          }
          yield* control.assertQueue("control-during-block", { exclusive: true })
          yield* broker.ctl(
            0,
            ...(alarm === "memory"
              ? ["set_vm_memory_high_watermark", "0.6"] :
              ["set_disk_free_limit", "50000000"])
          )
          expect((yield* Fiber.join(unblocked)).length).toBe(1)
          yield* Fiber.join(pending)
          const resumed = yield* control.get(queue)
          expect(Option.isSome(resumed)).toBe(true)
          if (Option.isSome(resumed)) {
            expect(decode(resumed.value.content)).toBe("resume-after-alarm")
            yield* control.ack(resumed.value)
          }
        }).pipe(Effect.scoped, Effect.timeout("300 seconds")),
      360000
    )
  }
})
