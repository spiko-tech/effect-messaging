import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"

const message: AMQPConsumeMessage.AMQPConsumeMessage = {
  content: new Uint8Array(),
  properties: {},
  fields: {
    consumerTag: "execution-test",
    deliveryTag: 1n,
    redelivered: false,
    exchange: "",
    routingKey: "execution"
  }
}

const unused = Effect.die("The subscriber must not use connection operations")
const connection: AMQPConnection.AMQPConnection = {
  [AMQPConnection.TypeId]: AMQPConnection.TypeId,
  createChannel: () => unused,
  serverProperties: unused,
  state: unused,
  changes: Stream.empty,
  awaitReady: unused,
  reconnect: unused,
  updateSecret: () => unused,
  close: unused
}

describe("AMQPSubscriber execution through the public native stream seam", () => {
  it.effect.each(["completion", "timeout"] as const)(
    "closes a one-delivery mailbox before handler drain (%s)",
    (mode) =>
      Effect.gen(function*() {
        const mailbox = yield* Queue.bounded<AMQPConsumeMessage.AMQPConsumeMessage>(1)
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const finalized = yield* Deferred.make<void>()
        const events: Array<string> = []
        const native = Layer.mock(AMQPChannel.AMQPChannel, {
          [AMQPChannel.TypeId]: AMQPChannel.TypeId,
          connection,
          consume: (_queue, options) => {
            expect(options?.prefetch).toBe(1)
            return Effect.succeed(Stream.unwrap(Effect.acquireRelease(
              Effect.succeed(Stream.fromQueue(mailbox)),
              () => Effect.sync(() => events.push("cancel")).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)))
            )))
          },
          ack: () =>
            Effect.sync(() => {
              events.push("ack")
            }),
          nack: (_message, allUpTo, requeue) =>
            Effect.sync(() => {
              expect(allUpTo).toBe(false)
              expect(requeue).toBe(false)
              events.push("nack")
            })
        })
        const subscriber = yield* AMQPSubscriber.make("execution", {
          concurrency: 1,
          ...(mode === "timeout" ? { handlerTimeout: "1 second" } : {})
        }).pipe(Effect.provide(native))
        const fiber = yield* subscriber.subscribe(
          Effect.gen(function*() {
            const delivery = yield* AMQPConsumeMessage.AMQPConsumeMessage
            const span = yield* Effect.currentSpan
            expect(delivery).toBe(message)
            expect(span.name).toBe("amqp.consume execution")
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            events.push("finished")
            return AMQPSubscriberResponse.ack()
          }).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined)))
        ).pipe(Effect.forkScoped)
        yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined))
        yield* Queue.offer(mailbox, message)
        yield* Deferred.await(started)
        yield* Effect.sync(() => fiber.interruptUnsafe())
        yield* Deferred.await(stopped)
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* Deferred.isDone(finalized)).toBe(false)
        if (mode === "timeout") yield* TestClock.adjust("1 second")
        else yield* Deferred.succeed(finish, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* Deferred.isDone(finalized)).toBe(true)
        expect(events).toEqual(mode === "timeout" ? ["cancel", "nack"] : ["cancel", "finished", "ack"])
      }).pipe(Effect.scoped)
  )

  it.effect.each([
    AMQPSubscriberResponse.ack(),
    AMQPSubscriberResponse.nack({ allUpTo: true, requeue: true }),
    AMQPSubscriberResponse.reject({ requeue: true })
  ])("dispatches $_tag settlement through the supplied native channel", (response) =>
    Effect.gen(function*() {
      const settlements: Array<ReadonlyArray<unknown>> = []
      const native = Layer.mock(AMQPChannel.AMQPChannel, {
        [AMQPChannel.TypeId]: AMQPChannel.TypeId,
        connection,
        consume: () => Effect.succeed(Stream.succeed(message)),
        ack: (...args) =>
          Effect.sync(() => {
            settlements.push(["Ack", ...args])
          }),
        nack: (...args) =>
          Effect.sync(() => {
            settlements.push(["Nack", ...args])
          }),
        reject: (...args) =>
          Effect.sync(() => {
            settlements.push(["Reject", ...args])
          })
      })
      const subscriber = yield* AMQPSubscriber.make("execution", { concurrency: 1 }).pipe(Effect.provide(native))
      yield* subscriber.subscribe(Effect.succeed(response))
      expect(settlements).toEqual(
        response._tag === "Ack"
          ? [["Ack", message]]
          : response._tag === "Nack"
          ? [["Nack", message, true, true]]
          : [["Reject", message, true]]
      )
    }))
})
