import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Result, Scheduler } from "effect"
import { vi } from "vitest"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPError from "../src/AMQPError.ts"
import { AMQPChannelError } from "../src/AMQPError.ts"
import * as Outbound from "../src/internal/outbound.ts"
import { makeBroker, nextMethod } from "./syntheticBroker.ts"

const scheduler = (maxBytes = 4096, maxCommands = 1) =>
  Outbound.make<object>({
    maxBytes,
    maxCommands,
    frameMax: () => 4096,
    isActive: () => true,
    isWritable: () => true,
    validate: () => undefined
  })

describe("outbound admission", { concurrent: false }, () => {
  it.effect("drops queued frames on cancellation but retains writing frames and budget until writer exit", () =>
    Effect.scoped(Effect.gen(function*() {
      const outbound = scheduler(4096, 2)
      const owner = {}
      const firstToken = yield* Effect.fromResult(outbound.reserve({ bytes: 2048, owner }))
      const first = yield* Effect.fromResult(outbound.commit({
        reservation: firstToken,
        frames: [new Uint8Array(2048)],
        channel: 1,
        physical: owner
      }))
      const secondToken = yield* Effect.fromResult(outbound.reserve({ bytes: 2048, owner }))
      const second = yield* Effect.fromResult(outbound.commit({
        reservation: secondToken,
        frames: [new Uint8Array(2048)],
        channel: 1,
        physical: owner
      }))
      const writing = Deferred.makeUnsafe<void>()
      const writer = yield* outbound.run(() => Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkScoped)
      yield* Deferred.await(writing)
      outbound.cancelCommand(second)
      expect(second.frames).toHaveLength(0)
      expect(outbound.usage()).toEqual({ bytes: 2048, commands: 1 })
      outbound.cancelCommand(first)
      expect(first.frames).toHaveLength(1)
      outbound.retire({
        matches: (command) => command.physical === owner,
        owner,
        error: () => new AMQPChannelError({ reason: "Channel retired" })
      })
      expect(first.frames).toHaveLength(1)
      expect(outbound.usage()).toEqual({ bytes: 2048, commands: 1 })
      outbound.retire({ error: () => new AMQPChannelError({ reason: "Session retired" }) })
      expect(first.frames).toHaveLength(1)
      expect(outbound.usage()).toEqual({ bytes: 2048, commands: 1 })
      yield* Fiber.interrupt(writer)
      expect(first.frames).toHaveLength(0)
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
    })))

  it.effect("retains only confirm slots after completed native writes, allowing fresh bounded admission", () =>
    Effect.scoped(Effect.gen(function*() {
      const commands: Array<Outbound.WriteCommand<object>> = []
      const original = Outbound.make
      const spy = vi.spyOn(Outbound, "make").mockImplementation((options) => {
        const outbound = original(options)
        return {
          ...outbound,
          commit: (request) => {
            const result = outbound.commit(request)
            if (request.reservation.publish && Result.isSuccess(result)) commands.push(result.success)
            return result
          }
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        frameMax: 4096,
        maxOutboundBytes: 8192
      })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel({ confirm: true, maxUnconfirmed: 8 })
      const publishers: Array<Fiber.Fiber<void, AMQPError.AMQPError>> = []
      for (let index = 0; index < 4; index++) {
        publishers.push(yield* channel.publish("", "queue", new Uint8Array(4096)).pipe(Effect.forkScoped))
        yield* nextMethod(session, 60, 40)
        const command = commands[index]
        expect(command).toBeDefined()
        if (command === undefined) return
        yield* Deferred.await(command.drained)
        expect(command.frames).toHaveLength(0)
      }
      expect(publishers.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)
      const publish = commands[0]
      if (publish === undefined) return
      yield* session.reply(publish.channel, 60, 80, { deliveryTag: BigInt(4), multiple: true })
      for (const fiber of publishers) yield* Fiber.join(fiber)
    })))

  it.effect("installs reservation cleanup before interruption at the reserve boundary", () =>
    Effect.scoped(Effect.gen(function*() {
      let victim: Fiber.Fiber<unknown, unknown> | undefined
      let interrupted = false
      const original = Outbound.make
      const spy = vi.spyOn(Outbound, "make").mockImplementation((options) => {
        const outbound = original(options)
        return {
          ...outbound,
          reserve: (request) => {
            const result = outbound.reserve(request)
            if (request.publish && !interrupted && Result.isSuccess(result)) {
              interrupted = true
              victim?.interruptUnsafe()
            }
            return result
          }
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        frameMax: 4096,
        maxOutboundBytes: 8192,
        maxPendingOperations: 1
      })
      const first = yield* connection.createChannel()
      const second = yield* connection.createChannel()
      const publishing = yield* Effect.withFiber((fiber) => {
        victim = fiber
        return first.publish("", "queue", new Uint8Array(4096))
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16), Effect.forkScoped)
      yield* Fiber.await(publishing)
      expect(interrupted).toBe(true)
      yield* second.publish("", "queue", new Uint8Array(4096))
      yield* first.publish("", "queue", new Uint8Array(4096))
    })))

  it.effect("releases pending admission across every low-budget scheduler interruption boundary", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        maxPendingOperations: 1,
        maxMessageBytes: 1
      })
      const channel = yield* connection.createChannel()
      for (let boundary = 1; boundary <= 100; boundary++) {
        let armed = false
        let operations = 0
        class InterruptScheduler extends Scheduler.MixedScheduler {
          override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
            if (armed && ++operations === boundary) fiber.interruptUnsafe()
            return super.shouldYield(fiber)
          }
        }
        const publishing = yield* Effect.withFiber(() => {
          armed = true
          return channel.publish("", "queue", new Uint8Array(2))
        }).pipe(
          Effect.provideService(Scheduler.Scheduler, new InterruptScheduler()),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
          Effect.forkScoped
        )
        yield* Fiber.await(publishing)
        yield* channel.publish("", "queue", new Uint8Array(1))
      }
    })))

  it.effect("retires an unframed reservation without touching a different channel's admission", () =>
    Effect.gen(function*() {
      const outbound = scheduler(4096, 4)
      const firstChannel = {}
      const secondChannel = {}
      const first = yield* Effect.fromResult(outbound.reserve({ bytes: 2048, owner: firstChannel }))
      const second = yield* Effect.fromResult(outbound.reserve({ bytes: 2048, owner: secondChannel }))
      outbound.retire({
        owner: firstChannel,
        matches: (command) => command.physical === firstChannel,
        error: () => new AMQPChannelError({ reason: "Test retirement" })
      })
      expect(first.state).toBe("Released")
      expect(second.state).toBe("Reserved")
      expect(outbound.usage()).toEqual({ bytes: 2048, commands: 1 })
      outbound.cancel(second)
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
    }))

  it.effect("bounds simultaneous channel reservations and preserves the separate control reserve", () =>
    Effect.gen(function*() {
      const outbound = scheduler(4096, 4)
      const first = yield* Effect.fromResult(outbound.reserve({ bytes: 3000, publish: true }))
      const second = yield* Effect.fromResult(outbound.reserve({ bytes: 1096, publish: true }))
      const firstCommand = yield* Effect.fromResult(outbound.commit({
        reservation: first,
        frames: [new Uint8Array(3000)],
        channel: 1,
        physical: {}
      }))
      const secondCommand = yield* Effect.fromResult(outbound.commit({
        reservation: second,
        frames: [new Uint8Array(1096)],
        channel: 2,
        physical: {}
      }))
      expect(Result.isFailure(outbound.reserve({ bytes: 1, publish: true }))).toBe(true)
      const control = yield* Effect.fromResult(outbound.reserve({ bytes: 8, priority: true }))
      outbound.cancel(control)
      expect(outbound.usage()).toEqual({ bytes: 4096, commands: 2 })
      outbound.retire({ error: () => new AMQPChannelError({ reason: "Test retirement" }) })
      expect(firstCommand.frames).toHaveLength(0)
      expect(secondCommand.frames).toHaveLength(0)
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
    }))

  it.effect("interrupts body encoding and releases its connection-wide reservation", () =>
    Effect.scoped(Effect.gen(function*() {
      const reserved = Deferred.makeUnsafe<void>()
      const original = Outbound.make
      const spy = vi.spyOn(Outbound, "make").mockImplementation((options) => {
        const outbound = original(options)
        return {
          ...outbound,
          reserve: (request) => {
            const result = outbound.reserve(request)
            if (request.publish && Result.isSuccess(result)) Deferred.doneUnsafe(reserved, Effect.void)
            return result
          }
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const broker = yield* makeBroker({ frameMax: 4096 })
      const connection = yield* AMQPConnection.make(broker.factory, {
        heartbeat: 0,
        maxOutboundBytes: 1100000,
        frameMax: 4096
      })
      const first = yield* connection.createChannel()
      const second = yield* connection.createChannel()
      const publishing = yield* first.publish("", "queue", new Uint8Array(1024 * 1024), { headers: {} }).pipe(
        Effect.forkScoped
      )
      yield* Deferred.await(reserved)
      yield* Fiber.interrupt(publishing)
      yield* second.publish("", "queue", new Uint8Array(1024 * 1024), { headers: {} })
    })))

  it.effect("interrupts broker-flow waits before encoding or reserving the body", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0, maxOutboundBytes: 4096 })
      const session = yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      const opening = yield* nextMethod(session, 20, 10)
      yield* session.reply(opening.channel, 20, 20, { active: false })
      yield* nextMethod(session, 20, 21)
      const publishing = yield* channel.publish("", "queue", new Uint8Array(1), { headers: {} }).pipe(Effect.forkScoped)
      yield* Fiber.interrupt(publishing)
      yield* session.reply(opening.channel, 20, 20, { active: true })
      yield* nextMethod(session, 20, 21)
      yield* channel.publish("", "queue", new Uint8Array(1), { headers: {} })
    })))

  it.effect("reserves count and bytes atomically across channels and releases failed framing", () =>
    Effect.gen(function*() {
      const outbound = scheduler()
      const token = yield* Effect.fromResult(outbound.reserve({ bytes: 4096, publish: true }))
      expect(Result.isFailure(outbound.reserve({ bytes: 1, publish: true }))).toBe(true)
      expect(outbound.usage()).toEqual({ bytes: 4096, commands: 1 })
      expect(Result.isFailure(outbound.commit({ reservation: token, frames: [new Uint8Array(8)], channel: 2 }))).toBe(
        true
      )
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
      const control = yield* Effect.fromResult(outbound.reserve({ bytes: 8, priority: true }))
      outbound.cancel(control)
      outbound.cancel(control)
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
    }))

  it.effect("releases reservations before reentrant write completion resumes a caller", () =>
    Effect.gen(function*() {
      const outbound = scheduler()
      const token = yield* Effect.fromResult(outbound.reserve({ bytes: 8 }))
      let installed = false
      const command = yield* Effect.fromResult(outbound.commit({
        reservation: token,
        frames: [new Uint8Array(8)],
        channel: 1,
        onAdmitted: () => {
          installed = true
        }
      }))
      const writer = yield* outbound.run(() => Effect.sync(() => expect(installed).toBe(true))).pipe(Effect.forkScoped)
      yield* Deferred.await(command.done)
      expect(command.frames).toHaveLength(0)
      const next = yield* Effect.fromResult(outbound.reserve({ bytes: 8 }))
      outbound.cancel(next)
      expect(outbound.usage()).toEqual({ bytes: 0, commands: 0 })
      yield* Fiber.interrupt(writer)
    }).pipe(Effect.scoped))

  it.effect("rejects an impossible 1 MiB publish before body slicing or copying", () =>
    Effect.scoped(Effect.gen(function*() {
      const broker = yield* makeBroker()
      const connection = yield* AMQPConnection.make(broker.factory, { heartbeat: 0, maxOutboundBytes: 4096 })
      yield* Queue.take(broker.sessions)
      const channel = yield* connection.createChannel()
      let slices = 0
      class Body extends Uint8Array {
        override subarray(begin?: number, end?: number): Uint8Array<ArrayBuffer> {
          slices++
          return super.subarray(begin, end)
        }
      }
      const result = yield* Effect.result(channel.publish("", "queue", new Body(1024 * 1024), { headers: {} }))
      expect(Result.isFailure(result)).toBe(true)
      expect(slices).toBe(0)
      yield* channel.publish("", "queue", new Uint8Array(1), { headers: {} })
    })))
})
