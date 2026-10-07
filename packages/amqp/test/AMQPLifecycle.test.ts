import { describe, expect, it, vi } from "@effect/vitest"
import type { Channel } from "amqplib"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schedule, Stream, SubscriptionRef } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { EventEmitter } from "node:events"
import { closeChannel, InternalAMQPChannel } from "../src/internal/AMQPChannel.ts"
import { closeStream, errorStream, trackResource } from "../src/internal/closeStream.ts"

const makeResource = () => trackResource(new EventEmitter() as unknown as Channel)

const waitForListeners = (resource: Channel, eventName: string, count: number) =>
  Effect.repeat(Effect.yieldNow, { until: () => resource.listenerCount(eventName) >= count })

const makeClosingChannel = Effect.fnUntraced(function*() {
  const started = yield* Deferred.make<void>()
  let finishConfirms = () => {}
  const resource = Object.assign(makeResource(), {
    close: vi.fn(async () => {
      resource.emit("close")
    }),
    waitForConfirms: vi.fn(() =>
      new Promise<void>((resolve) => {
        finishConfirms = resolve
        Deferred.doneUnsafe(started, Effect.void)
      })
    )
  })
  const channelRef = yield* SubscriptionRef.make(Option.some<Channel>(resource))
  const internal = InternalAMQPChannel.of({
    channelRef,
    serverProperties: {
      host: "localhost",
      product: "RabbitMQ",
      version: "test",
      platform: "test",
      information: "test",
      hostname: "localhost",
      port: "5679"
    },
    retryConnectionSchedule: Schedule.spaced("1 second"),
    retryConsumptionSchedule: Schedule.spaced("1 second"),
    waitChannelTimeout: "5 seconds",
    confirm: true,
    confirmTimeout: "30 seconds"
  })
  return {
    resource,
    channelRef,
    started,
    finishConfirms: () => finishConfirms(),
    close: closeChannel().pipe(Effect.provideService(InternalAMQPChannel, internal))
  }
})

// Vitest clears all mocks before each test, so lifecycle mock assertions must not run concurrently.
describe("AMQP resource lifecycle", { concurrent: false }, () => {
  it.live("observes resources closed before monitor registration", () =>
    Effect.gen(function*() {
      const resource = makeResource()
      const ref = yield* SubscriptionRef.make(Option.some(resource))
      resource.emit("close")

      const events = yield* closeStream(ref).pipe(Stream.take(1), Stream.runCollect, Effect.timeout("1 second"))

      expect(events).toEqual([undefined])
    }))

  it.live("delivers a close event before ending its stream", () =>
    Effect.gen(function*() {
      const resource = makeResource()
      const ref = yield* SubscriptionRef.make(Option.some(resource))
      const fiber = yield* Effect.forkChild(closeStream(ref).pipe(Stream.take(1), Stream.runCollect))
      yield* waitForListeners(resource, "close", 3)

      resource.emit("close")

      expect(yield* Fiber.join(fiber)).toEqual([undefined])
      expect(resource.listenerCount("close")).toBe(0)
    }))

  it.live("removes monitor listeners when interrupted", () =>
    Effect.gen(function*() {
      const resource = makeResource()
      const ref = yield* SubscriptionRef.make(Option.some(resource))
      const fiber = yield* Effect.forkChild(closeStream(ref).pipe(Stream.runDrain))
      yield* waitForListeners(resource, "close", 3)

      yield* Fiber.interrupt(fiber)

      expect(resource.listenerCount("close")).toBe(1)
    }))

  it.live("handles errors before and after monitor registration", () =>
    Effect.gen(function*() {
      const resource = makeResource()
      const error = new Error("channel failure")
      expect(() => resource.emit("error", error)).not.toThrow()
      const ref = yield* SubscriptionRef.make(Option.some(resource))
      const fiber = yield* Effect.forkChild(errorStream(ref).pipe(Stream.take(1), Stream.runCollect))
      yield* waitForListeners(resource, "error", 2)

      resource.emit("error", error)

      expect(yield* Fiber.join(fiber)).toEqual([error])
      expect(resource.listenerCount("error")).toBe(1)
      expect(resource.listenerCount("close")).toBe(1)
    }))

  it.effect("closes a channel after an interrupted confirm drain", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)

      yield* Fiber.interrupt(closing)

      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.none())
      const exit = yield* Fiber.await(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      channel.finishConfirms()
    }))

  it.effect("drains confirms before closing normally", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)

      expect(channel.resource.close).not.toHaveBeenCalled()
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.some(channel.resource))
      channel.finishConfirms()
      yield* Fiber.join(closing)

      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.none())
    }))

  it.effect("bounds confirm draining in an uninterruptible finalizer", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const closing = yield* Effect.forkChild(
        Effect.void.pipe(Effect.ensuring(channel.close))
      )
      yield* Deferred.await(channel.started)

      yield* TestClock.adjust("30 seconds")
      yield* Fiber.join(closing)

      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.none())
      channel.finishConfirms()
    }))

  it.effect("allows cancellation before acquiring the channel lock", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const locked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closeStarted = yield* Deferred.make<void>()
      const holding = yield* Effect.forkChild(
        SubscriptionRef.updateEffect(channel.channelRef, (current) =>
          Deferred.succeed(locked, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(current)
          ))
      )
      yield* Deferred.await(locked)
      const closing = yield* Effect.forkChild(
        Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(channel.close))
      )
      yield* Deferred.await(closeStarted)
      const interruption = yield* Effect.forkChild(
        Fiber.interrupt(closing).pipe(Effect.timeout("1 second"), Effect.exit)
      )

      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(interruption)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holding)

      expect(result).toEqual(Exit.succeed(undefined))
      expect(channel.resource.close).not.toHaveBeenCalled()
      expect(channel.resource.waitForConfirms).not.toHaveBeenCalled()
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.some(channel.resource))
    }))

  it.effect("holds the channel lock until interrupted native close finishes", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const nativeCloseStarted = yield* Deferred.make<void>()
      let finishClose = () => {}
      channel.resource.close.mockImplementation(() =>
        new Promise<void>((resolve) => {
          finishClose = resolve
          Deferred.doneUnsafe(nativeCloseStarted, Effect.void)
        })
      )
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)
      const interruption = yield* Effect.forkChild(Fiber.interrupt(closing))
      yield* Deferred.await(nativeCloseStarted)
      const replacement = makeResource()
      const replacing = yield* Effect.forkChild(
        SubscriptionRef.set(channel.channelRef, Option.some<Channel>(replacement))
      )

      yield* TestClock.adjust("1 second")
      const closePending = interruption.pollUnsafe() === undefined
      const replacementPending = replacing.pollUnsafe() === undefined
      const duringClose = yield* SubscriptionRef.get(channel.channelRef)
      finishClose()
      yield* Fiber.join(interruption)
      yield* Fiber.join(replacing)

      expect(closePending).toBe(true)
      expect(replacementPending).toBe(true)
      expect(duringClose).toEqual(Option.some(channel.resource))
      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.some(replacement))
      channel.finishConfirms()
    }))

  it.effect("preserves a replacement queued behind an interrupted close", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const replacement = Object.assign(makeResource(), { close: vi.fn(async () => {}) })
      const watching = yield* Deferred.make<void>()
      const replacingStarted = yield* Deferred.make<void>()
      const replacementCommitted = yield* Deferred.make<void>()
      const withPermit = channel.channelRef.semaphore.withPermit
      let firstPermit = true
      // Pause after releasing the first lock so the replacement commits before failed-update repair.
      vi.spyOn(channel.channelRef.semaphore, "withPermit").mockImplementation((self) => {
        const locked = withPermit(self)
        if (!firstPermit) return locked
        firstPermit = false
        return locked.pipe(Effect.onExit(() => Deferred.await(replacementCommitted)))
      })
      const updates = yield* Ref.make<Array<Option.Option<Channel>>>([])
      const changes = yield* Effect.forkChild(
        SubscriptionRef.changes(channel.channelRef).pipe(
          Stream.tap((current) => Ref.update(updates, (values) => [...values, current])),
          Stream.tap(() => Deferred.succeed(watching, undefined)),
          Stream.runDrain,
          Effect.timeout("1 second"),
          Effect.exit
        )
      )
      yield* Deferred.await(watching)
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)
      const replacing = yield* Effect.forkChild(
        Deferred.succeed(replacingStarted, undefined).pipe(
          Effect.andThen(SubscriptionRef.set(channel.channelRef, Option.some<Channel>(replacement))),
          Effect.andThen(Deferred.succeed(replacementCommitted, undefined))
        )
      )
      yield* Deferred.await(replacingStarted)

      yield* Fiber.interrupt(closing)
      yield* Fiber.join(replacing)
      yield* TestClock.adjust("1 second")

      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(replacement.close).not.toHaveBeenCalled()
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.some(replacement))
      expect(yield* Fiber.join(changes)).toEqual(Exit.fail(expect.objectContaining({ _tag: "TimeoutError" })))
      const replacements = (yield* Ref.get(updates)).filter((current) =>
        Option.isSome(current) && current.value === replacement
      )
      expect(replacements).toHaveLength(1)
      channel.finishConfirms()
    }))

  it.effect("does not replay intentional shutdown to a late monitor", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)
      const monitor = yield* Effect.forkChild(
        closeStream(channel.channelRef).pipe(Stream.take(1), Stream.runCollect, Effect.timeout("1 second"), Effect.exit)
      )

      yield* TestClock.adjust("1 second")

      expect(yield* Fiber.join(monitor)).toEqual(Exit.fail(expect.objectContaining({ _tag: "TimeoutError" })))
      channel.finishConfirms()
      yield* Fiber.join(closing)
    }))

  it.effect("does not reconnect if the channel closes during intentional shutdown", () =>
    Effect.gen(function*() {
      const channel = yield* makeClosingChannel()
      const monitor = yield* Effect.forkChild(
        closeStream(channel.channelRef).pipe(Stream.take(1), Stream.runCollect, Effect.timeout("1 second"), Effect.exit)
      )
      yield* waitForListeners(channel.resource, "close", 3)
      const closing = yield* Effect.forkChild(channel.close)
      yield* Deferred.await(channel.started)

      channel.resource.emit("close")
      yield* TestClock.adjust("1 second")

      expect(yield* Fiber.join(monitor)).toEqual(Exit.fail(expect.objectContaining({ _tag: "TimeoutError" })))
      channel.finishConfirms()
      yield* Fiber.join(closing)
    }))
})
