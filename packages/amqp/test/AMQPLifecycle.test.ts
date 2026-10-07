import { describe, expect, it, vi } from "@effect/vitest"
import type { Channel } from "amqplib"
import { Deferred, Effect, Exit, Fiber, Option, Schedule, Stream, SubscriptionRef } from "effect"
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
      channel.finishConfirms()
      yield* channel.close

      expect(channel.resource.close).toHaveBeenCalledTimes(1)
      expect(yield* SubscriptionRef.get(channel.channelRef)).toEqual(Option.none())
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
