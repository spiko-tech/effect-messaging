import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Fiber, Option, Queue, Result, Schedule, Scheduler, Stream } from "effect"
import { vi } from "vitest"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import * as Codec from "../src/internal/codec.ts"
import { broker as realBroker } from "./dependencies.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

vi.mock("@effect/platform-node/NodeSocket", { spy: true })

describe("client review regressions", () => {
  it.effect("preserves TLS buffer identity and captures inherited Node and TLS options once", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const captured: Array<Parameters<typeof NodeSocket.makeTls>[0]> = []
      const spy = vi.spyOn(NodeSocket, "makeTls").mockImplementation((options) => {
        captured.push(options)
        return broker.factory.pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const certificate = Buffer.from("opaque certificate")
      let hostnameReads = 0
      let certReads = 0
      class TlsOptions {
        get cert() {
          certReads++
          return certificate
        }
      }
      class NodeOptions {
        get hostname() {
          hostnameReads++
          return "localhost"
        }
        readonly heartbeat = 0
        readonly tls = new TlsOptions()
      }
      yield* AMQPNodeConnection.make(new NodeOptions())
      expect(captured).toHaveLength(1)
      expect(captured[0]?.cert).toBe(certificate)
      expect([hostnameReads, certReads]).toEqual([1, 1])
    })))

  it.effect("reads inherited configuration once without reflecting into opaque schedules and durations", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      let heartbeatReads = 0
      let prefetchReads = 0
      const retry = new Proxy(Schedule.recurs(0), {
        ownKeys: () => {
          throw new Error("schedule must stay opaque")
        }
      })
      const timeout = new Proxy(Duration.seconds(1), {
        ownKeys: () => {
          throw new Error("duration must stay opaque")
        }
      })
      class ConnectionOptions {
        get heartbeat() {
          heartbeatReads++
          return 0
        }
        readonly retryConnectionSchedule = retry
        readonly connectionTimeout = timeout
      }
      class ChannelOptions {
        get prefetch() {
          if (++prefetchReads > 1) throw new Error("prefetch reread")
          return 7
        }
      }
      const connection = yield* AMQPConnection.make(broker.factory, new ConnectionOptions())
      const session = yield* Queue.take(broker.sessions)
      yield* connection.createChannel(new ChannelOptions())
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(7)
      expect([heartbeatReads, prefetchReads]).toEqual([1, 1])
    })))

  it.effect("rejects throwing channel and delete option getters as typed failures before wire admission", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const badChannel = yield* Effect.exit(connection.createChannel({
        get prefetch(): number {
          throw new Error("foreign channel option")
        }
      }))
      expect(Exit.isFailure(badChannel) && !Exit.hasDies(badChannel)).toBe(true)
      if (Exit.isFailure(badChannel)) {
        expect(Cause.squash(badChannel.cause)).toMatchObject({ _tag: "AMQPProtocolError" })
      }
      const channel = yield* connection.createChannel()
      yield* nextMethod(session, 20, 10)
      yield* nextMethod(session, 60, 10)
      for (
        const operation of [
          channel.deleteQueue("queue", {
            get ifUnused(): boolean {
              throw new Error("foreign deletion option")
            }
          }),
          channel.deleteExchange("exchange", {
            get ifUnused(): boolean {
              throw new Error("foreign deletion option")
            }
          }),
          channel.get("queue", {
            get noAck(): boolean {
              throw new Error("foreign get option")
            }
          })
        ]
      ) {
        const result = yield* Effect.exit(operation)
        expect(Exit.isFailure(result) && !Exit.hasDies(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ _tag: "AMQPProtocolError" })
      }
      expect(Queue.sizeUnsafe(session.methods)).toBe(0)
    })))

  it.effect("rejects throwing connection and Node option getters without constructing a transport", () =>
    Effect.scoped(Effect.gen(function*() {
      let constructed = 0
      const factory = Effect.suspend(() => {
        constructed++
        return Effect.never
      })
      const sentinel = "configuration-private-secret"
      for (
        const operation of [
          AMQPConnection.make(factory, {
            get username(): string {
              throw new Error(sentinel)
            }
          }),
          AMQPNodeConnection.make({
            get hostname(): string {
              throw new Error(sentinel)
            }
          }),
          AMQPNodeConnection.make("amqp://localhost", {
            get username(): string {
              throw new Error(sentinel)
            }
          }),
          AMQPNodeConnection.make({
            tls: {
              get ca(): string {
                throw new Error(sentinel)
              }
            }
          })
        ]
      ) {
        const result = yield* Effect.exit(operation)
        expect(Exit.isFailure(result) && !Exit.hasDies(result)).toBe(true)
        expect(JSON.stringify(result)).not.toContain(sentinel)
        if (Exit.isFailure(result)) {
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "AMQPConnectionError", permanent: true })
          expect(Cause.pretty(result.cause)).not.toContain(sentinel)
        }
      }
      expect(constructed).toBe(0)
    })))

  it.effect("commits transaction receipt authority on reply before an interrupted RPC caller resumes", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const selecting = yield* channel.txSelect().pipe(Effect.forkScoped)
      const select = yield* nextMethod(session, 90, 10)
      yield* session.reply(select.channel, 90, 11)
      yield* Fiber.join(selecting)
      const getting = yield* channel.get("queue").pipe(Effect.forkScoped)
      const get = yield* nextMethod(session, 60, 70)
      yield* session.reply(get.channel, 60, 71, {
        deliveryTag: BigInt(1),
        redelivered: false,
        exchange: "",
        routingKey: "queue",
        messageCount: 0
      })
      yield* session.send(yield* Codec.encodeContentHeader(get.channel, BigInt(0), {}))
      const message = Option.getOrThrow(yield* Fiber.join(getting))
      yield* channel.ack(message)
      for (const action of ["Rollback", "Commit"] as const) {
        let armed = false
        let dispatcher: Scheduler.SchedulerDispatcher | undefined
        class InterruptScheduler extends Scheduler.MixedScheduler {
          override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
            if (armed) {
              armed = false
              fiber.interruptUnsafe()
            }
            return super.shouldYield(fiber)
          }
        }
        const changing = yield* Effect.withFiber((fiber) => {
          dispatcher = fiber.currentDispatcher
          return action === "Rollback" ? channel.txRollback() : channel.txCommit()
        }).pipe(Effect.provideService(Scheduler.Scheduler, new InterruptScheduler("sync")), Effect.forkScoped)
        const request = yield* nextMethod(session, 90, action === "Rollback" ? 30 : 20)
        // Flush the command-write continuation so this caller is parked awaiting the broker reply.
        dispatcher?.flush()
        armed = true
        yield* session.reply(request.channel, 90, action === "Rollback" ? 31 : 21)
        expect(Exit.isFailure(yield* Fiber.await(changing))).toBe(true)
        if (action === "Rollback") {
          // Rollback must restore this original receipt even though the caller never returned successfully.
          yield* channel.ack(message)
        }
      }
      const rollback = yield* channel.txRollback().pipe(Effect.forkScoped)
      const request = yield* nextMethod(session, 90, 30)
      yield* session.reply(request.channel, 90, 31)
      yield* Fiber.join(rollback)
      const settled = yield* Effect.result(channel.ack(message))
      expect(Result.isFailure(settled)).toBe(true)
      if (Result.isFailure(settled) && settled.failure._tag === "AMQPSettlementError") {
        expect(settled.failure.kind).toBe("AlreadySettled")
      }
    })))

  it.effect("uses intrinsic body size and slicing without invoking foreign typed-array overrides", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        frameMax: 4096,
        maxMessageBytes: 8192
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      class Body extends Uint8Array {
        override get byteLength(): number {
          throw new Error("foreign byteLength")
        }
        override subarray(): Uint8Array<ArrayBuffer> {
          throw new Error("foreign subarray")
        }
      }
      yield* channel.publish("", "queue", new Body(5000))
      yield* nextMethod(session, 60, 40)
      const header = yield* Queue.take(session.frames).pipe(
        Effect.repeat({ until: (frame) => frame.type === 2 })
      )
      expect((yield* Codec.decodeContentHeader(header.payload)).bodySize).toBe(BigInt(5000))
      const first = yield* Queue.take(session.frames)
      const second = yield* Queue.take(session.frames)
      expect([first.payload.byteLength, second.payload.byteLength]).toEqual([4088, 912])
      const tooLarge = yield* Effect.result(channel.publish("", "queue", new Body(8193)))
      expect(Result.isFailure(tooLarge)).toBe(true)
      yield* channel.publish("", "queue", new Uint8Array(1))
    })))

  it.effect("uses the normalized mandatory snapshot without rereading a foreign getter", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      let reads = 0
      yield* channel.publish("", "queue", new Uint8Array(1), {
        get mandatory() {
          if (++reads > 1) throw new Error("mandatory reread")
          return true
        }
      })
      expect(reads).toBe(1)
      expect((yield* nextMethod(session, 60, 40)).fields.mandatory).toBe(true)
    })))

  it.effect("snapshots consumer configuration once, including priority precedence and acknowledgement flags", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      yield* nextMethod(session, 60, 10)
      let prefetchReads = 0
      let priorityReads = 0
      let noAckReads = 0
      yield* channel.consume("queue", {
        get prefetch() {
          return ++prefetchReads === 1 ? 1 : 2
        },
        get priority() {
          return ++priorityReads === 1 ? 10 : -10
        },
        get noAck() {
          return ++noAckReads === 1
        },
        arguments: { "x-priority": -1 }
      }).pipe(Effect.asVoid)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(1)
      const consume = yield* nextMethod(session, 60, 20)
      expect(consume.fields.arguments).toEqual({ "x-priority": 10 })
      expect(consume.fields.noAck).toBe(true)
      expect([prefetchReads, priorityReads, noAckReads]).toEqual([1, 1, 1])
      for (
        const options of [
          Object.defineProperty({}, "noAck", { value: "invalid", enumerable: true }),
          new Proxy({}, {
            getPrototypeOf: () => {
              throw new Error("reflection failure")
            }
          })
        ]
      ) {
        const result = yield* Effect.result(channel.consume("queue", options))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AMQPProtocolError")
      }
    })))

  it.effect("delete-ok retires consumers across owners before a loss can restore deleted subscriptions", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        retryConnectionSchedule: Schedule.recurs(3)
      })
      const session = yield* Queue.take(broker.sessions)
      const declaringOwner = yield* connection.createChannel()
      const consumingOwner = yield* connection.createChannel()
      const deletedQueue = yield* declaringOwner.assertQueue("deleted")
      yield* consumingOwner.assertQueue("surviving")
      const deleted = yield* consumingOwner.consume(deletedQueue)
      const surviving = yield* consumingOwner.consume("surviving")
      const survivor = yield* surviving.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const deleting = yield* declaringOwner.deleteQueue(deletedQueue).pipe(Effect.forkScoped)
      const request = yield* nextMethod(session, 50, 40)
      yield* session.reply(request.channel, 50, 41, { messageCount: 0 })
      yield* Fiber.join(deleting)
      // No broker basic.cancel is emitted: lose the session after delete-ok but before any cancel notification.
      yield* session.disconnect
      const replacement = yield* Queue.take(broker.sessions)
      yield* connection.awaitReady
      const restored = yield* nextMethod(replacement, 60, 20)
      expect(restored.fields.queue).toBe("surviving")
      const retired = yield* Effect.result(Stream.runDrain(deleted))
      expect(Result.isFailure(retired)).toBe(true)
      if (Result.isFailure(retired)) {
        expect(retired.failure).toMatchObject({
          _tag: "AMQPChannelError",
          reason: "Broker cancelled consumer: queue was deleted"
        })
      }
      yield* replacement.reply(restored.channel, 60, 60, {
        consumerTag: "synthetic-consumer",
        deliveryTag: BigInt(1),
        redelivered: false,
        exchange: "",
        routingKey: "surviving"
      })
      yield* replacement.send(yield* Codec.encodeContentHeader(restored.channel, BigInt(0), {}))
      expect((yield* Fiber.join(survivor)).length).toBe(1)
    })))

  it.live("preserves RabbitMQ's connection-level 540 diagnostics for unsupported flow and recovery", () =>
    Effect.scoped(Effect.gen(function*() {
      const connection = yield* AMQPNodeConnection.make(realBroker, { heartbeat: 0 })
      const channel = yield* connection.createChannel()
      expect(yield* channel.flow(true)).toBe(true)
      const unsupportedFlow = yield* Effect.result(channel.flow(false))
      expect(Result.isFailure(unsupportedFlow)).toBe(true)
      if (Result.isFailure(unsupportedFlow)) {
        expect(unsupportedFlow.failure._tag).toBe("AMQPConnectionError")
        if (unsupportedFlow.failure._tag === "AMQPConnectionError") expect(unsupportedFlow.failure.replyCode).toBe(540)
      }
      const retired = yield* Effect.result(channel.flow(true))
      expect(Result.isFailure(retired)).toBe(true)
      const recoveryConnection = yield* AMQPNodeConnection.make(realBroker, { heartbeat: 0 })
      const recoveryChannel = yield* recoveryConnection.createChannel()
      yield* recoveryChannel.recover()
      const unsupportedRecover = yield* Effect.result(recoveryChannel.recover(false))
      expect(Result.isFailure(unsupportedRecover)).toBe(true)
      if (Result.isFailure(unsupportedRecover)) {
        expect(unsupportedRecover.failure._tag).toBe("AMQPConnectionError")
        if (unsupportedRecover.failure._tag === "AMQPConnectionError") {
          expect(unsupportedRecover.failure.replyCode).toBe(540)
        }
      }
      const recoveryRetired = yield* Effect.result(recoveryChannel.recover())
      expect(Result.isFailure(recoveryRetired)).toBe(true)
    })).pipe(Effect.timeout("10 seconds")))

  it.effect("captures effective consumer QoS once and restores the channel default after recovery", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        retryConnectionSchedule: Schedule.recurs(3)
      })
      const first = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ prefetch: 1 })
      yield* channel.consume("queue").pipe(Effect.asVoid)
      yield* channel.prefetch(2)
      yield* connection.reconnect
      const second = yield* Queue.take(broker.sessions)
      expect((yield* nextMethod(second, 60, 10)).fields.prefetchCount).toBe(2)
      expect((yield* nextMethod(second, 60, 10)).fields.prefetchCount).toBe(1)
      yield* nextMethod(second, 60, 20)
      expect((yield* nextMethod(second, 60, 10)).fields.prefetchCount).toBe(2)
      expect(first).not.toBe(second)
    })))

  it.effect("allows unlimited wire QoS and resets a finite QoS to zero", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ prefetch: 0 })
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(0)
      yield* channel.prefetch(2)
      yield* channel.prefetch(0)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(2)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(0)
      yield* channel.consume("queue", { prefetch: 0, maxBufferedMessages: 3 }).pipe(Effect.asVoid)
      expect((yield* nextMethod(session, 60, 10)).fields.prefetchCount).toBe(0)
    })))
})
