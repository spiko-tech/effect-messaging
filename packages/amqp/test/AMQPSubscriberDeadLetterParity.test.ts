import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { randomUUID } from "node:crypto"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"
import { encode, testConfirmChannel } from "./dependencies.ts"

interface Settlement {
  readonly kind: "ack" | "nack"
  readonly messageId: string | undefined
  readonly allUpTo?: boolean | undefined
  readonly requeue?: boolean | undefined
}

const fixture = Effect.fnUntraced(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  const cleanup = yield* channel.connection.createChannel()
  const prefix = `effect-subscriber-dlx-${randomUUID()}`
  const source = `${prefix}.source`
  const dlx = `${prefix}.dlx`
  const queueName = `${prefix}.queue`
  const dlqName = `${prefix}.dlq`
  const siblingName = `${prefix}.sibling`
  yield* Effect.addFinalizer(() =>
    Effect.gen(function*() {
      for (const name of [queueName, siblingName, dlqName]) yield* cleanup.deleteQueue(name).pipe(Effect.ignore)
      for (const name of [source, dlx]) yield* cleanup.deleteExchange(name).pipe(Effect.ignore)
    })
  )
  yield* channel.assertExchange(source, "direct", { durable: true })
  yield* channel.assertExchange(dlx, "direct", { durable: true })
  const dlq = yield* channel.assertQueue(dlqName, { durable: true, arguments: { "x-queue-type": "classic" } })
  yield* channel.bindQueue(dlq, dlx, "dead.route")
  const arguments_ = {
    "x-queue-type": "classic",
    "x-dead-letter-exchange": dlx,
    "x-dead-letter-routing-key": "dead.route"
  }
  const queue = yield* channel.assertQueue(queueName, { durable: true, arguments: arguments_ })
  const sibling = yield* channel.assertQueue(siblingName, { durable: true, arguments: arguments_ })
  yield* channel.bindQueue(queue, source, "original.route")
  const settled = yield* Queue.unbounded<Settlement>()
  // Inspect public settlements only after delegating to the real native channel; no fake channel or adapter.
  const observed: AMQPChannel.AMQPChannel = {
    ...channel,
    ack: (message, allUpTo) =>
      channel.ack(message, allUpTo).pipe(
        Effect.tap(() => Queue.offer(settled, { kind: "ack", messageId: message.properties.messageId }))
      ),
    nack: (message, allUpTo, requeue) =>
      channel.nack(message, allUpTo, requeue).pipe(
        Effect.tap(() =>
          Queue.offer(settled, { kind: "nack", messageId: message.properties.messageId, allUpTo, requeue })
        )
      )
  }
  const stream = yield* channel.consume(dlq)
  const receiving = yield* stream.pipe(
    Stream.take(1),
    Stream.mapEffect((message) => channel.ack(message).pipe(Effect.as(message))),
    Stream.runCollect,
    Effect.forkScoped({ startImmediately: true })
  )
  return { channel, observed, source, dlx, queue, dlq, sibling, settled, receiving }
})

describe("AMQP actual subscriber requeue dead-letter parity", () => {
  it.live(
    "R-C07 C-S50: explicit Nack requeues DEADLETTER, redelivered handler drops it through DLX to DLQ, GOOD is acked",
    () =>
      Effect.gen(function*() {
        const setup = yield* fixture()
        const admitted = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
        const subscriber = yield* AMQPSubscriber.make(setup.queue, { concurrency: 1 }).pipe(
          Effect.provideService(AMQPChannel.AMQPChannel, setup.observed)
        )
        const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
          const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
          yield* Queue.offer(admitted, message)
          if (message.properties.messageId === "DEADLETTER") {
            return AMQPSubscriberResponse.nack({ allUpTo: false, requeue: !message.fields.redelivered })
          }
          return AMQPSubscriberResponse.ack()
        })).pipe(Effect.forkScoped)
        const payload = new Uint8Array([0, 255, 68, 69, 65, 68, 0, 128])
        yield* setup.channel.publish(setup.source, "original.route", payload, {
          messageId: "DEADLETTER",
          persistent: true,
          headers: { application: "unchanged" }
        })
        const original = yield* Queue.take(admitted)
        expect(original.properties.messageId).toBe("DEADLETTER")
        expect(original.content).toEqual(payload)
        expect(original.fields.redelivered).toBe(false)
        expect(yield* Queue.take(setup.settled)).toEqual({
          kind: "nack",
          messageId: "DEADLETTER",
          allUpTo: false,
          requeue: true
        })
        const redelivered = yield* Queue.take(admitted)
        expect(redelivered.properties.messageId).toBe("DEADLETTER")
        expect(redelivered.content).toEqual(payload)
        expect(redelivered.fields.redelivered).toBe(true)
        expect(redelivered.fields.exchange).toBe(setup.source)
        expect(redelivered.fields.routingKey).toBe("original.route")
        expect(redelivered.properties.headers?.["x-death"]).toBeUndefined()
        expect(yield* Queue.take(setup.settled)).toEqual({
          kind: "nack",
          messageId: "DEADLETTER",
          allUpTo: false,
          requeue: false
        })
        const [dead] = yield* Fiber.join(setup.receiving)
        expectDeadLetter(dead, setup, payload)
        yield* setup.channel.publish(setup.source, "original.route", encode("GOOD"), { messageId: "GOOD" })
        const good = yield* Queue.take(admitted)
        expect(good.properties.messageId).toBe("GOOD")
        expect(good.content).toEqual(encode("GOOD"))
        expect(good.fields.redelivered).toBe(false)
        expect(yield* Queue.take(setup.settled)).toEqual({ kind: "ack", messageId: "GOOD" })
        yield* Fiber.interrupt(fiber)
        expect((yield* setup.channel.checkQueue(setup.queue)).messageCount).toBe(0)
        expect(yield* setup.channel.get(setup.dlq)).toEqual(Option.none())
        expect(yield* Queue.size(admitted)).toBe(0)
        expect(yield* Queue.size(setup.settled)).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )
})

const expectDeadLetter = (
  message: AMQPConsumeMessage.AMQPConsumeMessage,
  setup: { readonly source: string; readonly dlx: string; readonly queue: { readonly queue: string } },
  payload: Uint8Array
) => {
  expect(message.content).toEqual(payload)
  expect(message.properties.messageId).toBe("DEADLETTER")
  expect(message.properties.headers?.application).toBe("unchanged")
  expect(message.fields.exchange).toBe(setup.dlx)
  expect(message.fields.routingKey).toBe("dead.route")
  expect(message.properties.headers?.["x-death"]).toEqual([
    expect.objectContaining({
      reason: "rejected",
      queue: setup.queue.queue,
      exchange: setup.source,
      "routing-keys": ["original.route"]
    })
  ])
  expect(message.properties.headers).toEqual(expect.objectContaining({
    "x-first-death-reason": "rejected",
    "x-first-death-queue": setup.queue.queue,
    "x-first-death-exchange": setup.source
  }))
}

describe("AMQP actual subscriber dead-letter parity", () => {
  for (const failure of ["fail", "die"] as const) {
    it.live(
      `R-C07 C-S50: actual Effect.${failure} handler nacks DEADLETTER through DLX to DLQ, acknowledges GOOD and isolates sibling`,
      () =>
        Effect.gen(function*() {
          const setup = yield* fixture()
          const admitted = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
          const siblingAdmitted = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
          const sibling = yield* AMQPSubscriber.make(setup.sibling, { concurrency: 1 }).pipe(
            Effect.provideService(AMQPChannel.AMQPChannel, setup.observed)
          )
          const siblingFiber = yield* sibling.subscribe(Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            yield* Queue.offer(siblingAdmitted, message)
            return AMQPSubscriberResponse.ack()
          })).pipe(Effect.forkScoped)
          const subscriber = yield* AMQPSubscriber.make(setup.queue, { concurrency: 1 }).pipe(
            Effect.provideService(AMQPChannel.AMQPChannel, setup.observed)
          )
          const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
            const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
            yield* Queue.offer(admitted, message)
            if (message.properties.messageId === "DEADLETTER") {
              return yield* (failure === "fail"
                ? Effect.fail("ordinary handler failure")
                : Effect.die("handler defect"))
            }
            return AMQPSubscriberResponse.ack()
          })).pipe(Effect.forkScoped)
          const payload = new Uint8Array([0, 255, 68, 69, 65, 68, 0, 128])
          yield* setup.channel.publish(setup.source, "original.route", payload, {
            messageId: "DEADLETTER",
            persistent: true,
            headers: { application: "unchanged" }
          })
          const failed = yield* Queue.take(admitted)
          expect(failed.content).toEqual(payload)
          expect(failed.fields.redelivered).toBe(false)
          expect(yield* Queue.take(setup.settled)).toEqual({
            kind: "nack",
            messageId: "DEADLETTER",
            allUpTo: false,
            requeue: false
          })
          const [dead] = yield* Fiber.join(setup.receiving)
          expectDeadLetter(dead, setup, payload)
          yield* setup.channel.publish(setup.source, "original.route", encode("GOOD"), { messageId: "GOOD" })
          const good = yield* Queue.take(admitted)
          expect(good.properties.messageId).toBe("GOOD")
          expect(good.content).toEqual(encode("GOOD"))
          expect(good.fields.redelivered).toBe(false)
          expect(yield* Queue.take(setup.settled)).toEqual({ kind: "ack", messageId: "GOOD" })
          yield* setup.channel.sendToQueue(setup.sibling, encode("SIBLING"), { messageId: "SIBLING" })
          expect((yield* Queue.take(siblingAdmitted)).content).toEqual(encode("SIBLING"))
          expect(yield* Queue.take(setup.settled)).toEqual({ kind: "ack", messageId: "SIBLING" })
          yield* Fiber.interrupt(siblingFiber)
          yield* Fiber.interrupt(fiber)
          // Ordered channel RPCs after settlement/cancellation, not a timed absence assertion.
          expect((yield* setup.channel.checkQueue(setup.queue)).messageCount).toBe(0)
          expect(yield* setup.channel.get(setup.dlq)).toEqual(Option.none())
          expect(yield* Queue.size(admitted)).toBe(0)
          expect(yield* Queue.size(setup.settled)).toBe(0)
        }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
      15000
    )
  }
})
