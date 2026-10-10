import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Ref, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"
import * as Codec from "../src/internal/codec.ts"
import { decode, encode } from "./dependencies.ts"
import { makeBroker, nextMethod, type Session } from "./syntheticBroker.ts"

const deliver = Effect.fnUntraced(function*(
  session: Session,
  channel: number,
  deliveryTag: bigint,
  body: string,
  messageId: string,
  redelivered = false
) {
  const content = encode(body)
  yield* session.reply(channel, 60, 60, {
    consumerTag: "synthetic-consumer",
    deliveryTag,
    redelivered,
    exchange: "",
    routingKey: "adapter-retirement"
  })
  yield* session.send(yield* Codec.encodeContentHeader(channel, BigInt(content.length), { messageId }))
  yield* session.send(yield* Codec.encodeFrame(3, channel, content))
})

const adapter = Effect.fnUntraced(function*(channel: AMQPChannel.AMQPChannel) {
  const started = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
  const pulled = yield* Queue.unbounded<AMQPConsumeMessage.AMQPConsumeMessage>()
  const permits = yield* Queue.unbounded<void>()
  const active = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  // Observe the real public stream after native mailbox filtering, before the adapter waits for a permit.
  const observed: AMQPChannel.AMQPChannel = {
    ...channel,
    consume: (queue, options) =>
      channel.consume(queue, options).pipe(
        Effect.map((messages) => messages.pipe(Stream.tap((message) => Queue.offer(pulled, message))))
      )
  }
  const subscriber = yield* AMQPSubscriber.make("adapter-retirement", { concurrency: 1 })
    .pipe(Effect.provideService(AMQPChannel.AMQPChannel, observed))
  const fiber = yield* subscriber.subscribe(Effect.gen(function*() {
    const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
    const count = yield* Ref.updateAndGet(active, (n) => n + 1)
    yield* Ref.update(peak, (n) => Math.max(n, count))
    yield* Queue.offer(started, message)
    yield* Queue.take(permits)
    yield* Ref.update(active, (n) => n - 1)
    return AMQPSubscriberResponse.ack()
  })).pipe(Effect.exit, Effect.forkScoped)
  // Release held uninterruptible handlers even when the stale-admission assertion fails.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from({ length: 10 }),
      () => Queue.offer(permits, undefined),
      { discard: true }
    )
  )
  return { started, pulled, permits, fiber, active, peak }
})

// Gate only a peer's wire reply. The production connection, channel and consumer are unchanged.
const gatedPeer = Effect.fnUntraced(function*(replyMethod: 11 | 21) {
  const broker = yield* makeBroker({ automaticTopology: true })
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let armed = false
  const factory = broker.factory.pipe(
    Effect.flatMap(Effect.fnUntraced(function*(socket) {
      const decoder = yield* Codec.makeFrameDecoder()
      return Socket.make({
        writer: socket.writer,
        reader: socket.reader.pipe(Effect.map((reader) => ({
          upgrade: reader.upgrade,
          pull: reader.pull.pipe(
            Effect.tap((chunks) =>
              Effect.gen(function*() {
                for (const chunk of chunks) {
                  yield* decoder.feed(
                    typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
                    Effect.fnUntraced(function*(frame) {
                      if (frame.type !== 1) return true
                      const method = yield* Codec.decodeMethod(frame.payload)
                      if (armed && method.classId === 60 && method.methodId === replyMethod) {
                        armed = false
                        yield* Deferred.succeed(entered, undefined)
                        yield* Deferred.await(release)
                      }
                      return true
                    })
                  )
                }
              })
            ),
            Effect.mapError((cause) => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }))
          )
        })))
      })
    })),
    Effect.mapError((cause) =>
      new Socket.SocketError({
        reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
      })
    )
  )
  return {
    factory,
    entered,
    release,
    sessions: broker.sessions,
    arm: Effect.sync(() => {
      armed = true
    })
  }
})

describe("AMQP consumer controlled-peer fault parity", () => {
  it.live("R-C05 adversarial peer projection: actual subscriber never admits retired original green after channel failure", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const session = yield* Queue.take(broker.sessions)
      yield* channel.assertQueue("adapter-retirement")
      const consumer = yield* adapter(channel)
      const registration = yield* nextMethod(session, 60, 20)
      yield* deliver(session, registration.channel, 1n, "red", "original-red")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("original-red")
      expect((yield* Queue.take(consumer.started)).properties.messageId).toBe("original-red")
      yield* Queue.offer(consumer.permits, undefined)
      yield* nextMethod(session, 60, 80)
      yield* deliver(session, registration.channel, 2n, "blue", "original-blue")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("original-blue")
      expect((yield* Queue.take(consumer.started)).properties.messageId).toBe("original-blue")
      // Intentionally adversarial: extra delivery exceeds native prefetch one, unlike healthy RabbitMQ.
      // Confirm the actual adapter pulled this delivery before retiring its channel session.
      yield* deliver(session, registration.channel, 3n, "green", "retired-original-green")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("retired-original-green")
      expect(yield* Queue.size(consumer.started)).toBe(0)
      yield* session.reply(registration.channel, 20, 40, {
        replyCode: 404,
        replyText: "NOT_FOUND - controlled adapter channel failure",
        classId: 50,
        methodId: 10
      })
      yield* nextMethod(session, 20, 41)
      const restored = yield* nextMethod(session, 60, 20)
      yield* deliver(session, restored.channel, 1n, "blue", "current-blue", true)
      yield* channel.assertQueue("new-blue-delivery-barrier")
      expect(yield* Queue.size(consumer.started)).toBe(0)
      yield* Queue.offer(consumer.permits, undefined)
      const blue = yield* Queue.take(consumer.started)
      expect(blue.properties.messageId).toBe("current-blue")
      expect(decode(blue.content)).toBe("blue")
      expect(blue.fields.redelivered).toBe(true)
      yield* deliver(session, restored.channel, 2n, "green", "current-green", true)
      yield* channel.assertQueue("new-green-delivery-barrier")
      yield* Queue.offer(consumer.permits, undefined)
      const green = yield* Queue.take(consumer.started)
      expect(green.properties.messageId).toBe("current-green")
      expect(decode(green.content)).toBe("green")
      expect(green.fields.redelivered).toBe(true)
      yield* Queue.offer(consumer.permits, undefined)
      yield* Fiber.interrupt(consumer.fiber)
      expect(yield* Ref.get(consumer.peak)).toBe(1)
      expect(yield* Ref.get(consumer.active)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("actual subscriber skips a pulled delivery revoked by basic.recover while waiting for a permit", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const session = yield* Queue.take(broker.sessions)
      yield* channel.assertQueue("adapter-retirement")
      const consumer = yield* adapter(channel)
      const registration = yield* nextMethod(session, 60, 20)
      yield* deliver(session, registration.channel, 1n, "blue", "held-before-recover")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("held-before-recover")
      expect((yield* Queue.take(consumer.started)).properties.messageId).toBe("held-before-recover")
      // Deliberately exceed prefetch one to expose a pulled-but-not-handled delivery on the same session.
      yield* deliver(session, registration.channel, 2n, "blue", "revoked-before-recover")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("revoked-before-recover")
      expect(yield* Queue.size(consumer.started)).toBe(0)
      const recovering = yield* channel.recover().pipe(Effect.forkScoped)
      yield* nextMethod(session, 60, 110)
      yield* session.reply(registration.channel, 60, 111)
      yield* Fiber.join(recovering)
      yield* deliver(session, registration.channel, 3n, "blue", "current-after-recover", true)
      yield* Queue.offer(consumer.permits, undefined)
      const admitted = yield* Queue.take(consumer.started)
      expect(admitted.properties.messageId).toBe("current-after-recover")
      expect(admitted.fields.redelivered).toBe(true)
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("current-after-recover")
      yield* Queue.offer(consumer.permits, undefined)
      yield* Fiber.interrupt(consumer.fiber)
      expect(yield* Ref.get(consumer.peak)).toBe(1)
      expect(yield* Ref.get(consumer.active)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  it.live("R-C05 recovery projection: actual subscriber rejects a pulled delivery retired by a second reconnect", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const original = yield* Queue.take(broker.sessions)
      yield* channel.assertQueue("adapter-retirement")
      const consumer = yield* adapter(channel)
      const first = yield* nextMethod(original, 60, 20)
      yield* deliver(original, first.channel, 1n, "blue", "held-original-blue")
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("held-original-blue")
      expect((yield* Queue.take(consumer.started)).properties.messageId).toBe("held-original-blue")
      yield* connection.reconnect
      const replacement = yield* Queue.take(broker.sessions)
      const second = yield* nextMethod(replacement, 60, 20)
      yield* deliver(replacement, second.channel, 1n, "blue", "retired-replacement-blue", true)
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("retired-replacement-blue")
      expect(yield* Queue.size(consumer.started)).toBe(0)
      yield* connection.reconnect
      const current = yield* Queue.take(broker.sessions)
      const third = yield* nextMethod(current, 60, 20)
      yield* deliver(current, third.channel, 1n, "blue", "current-blue", true)
      expect(yield* Queue.size(consumer.started)).toBe(0)
      yield* Queue.offer(consumer.permits, undefined)
      const admitted = yield* Queue.take(consumer.started)
      expect(admitted.properties.messageId).toBe("current-blue")
      expect(decode(admitted.content)).toBe("blue")
      expect(admitted.fields.redelivered).toBe(true)
      expect((yield* Queue.take(consumer.pulled)).properties.messageId).toBe("current-blue")
      yield* Queue.offer(consumer.permits, undefined)
      yield* Fiber.interrupt(consumer.fiber)
      expect(yield* Ref.get(consumer.peak)).toBe(1)
      expect(yield* Ref.get(consumer.active)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))

  for (const replyMethod of [11, 21] as const) {
    it.live(`R-C01: cancels pending consumer setup while ${replyMethod === 11 ? "qos-ok" : "consume-ok"} is gated`, () =>
      Effect.gen(function*() {
        const peer = yield* gatedPeer(replyMethod)
        const connection = yield* AMQPConnection.make(peer.factory)
        const channel = yield* connection.createChannel()
        yield* channel.assertQueue("pending-consumer")
        yield* peer.arm
        const consumer = yield* channel.consume("pending-consumer", { prefetch: 1 }).pipe(
          Effect.andThen(Stream.runDrain),
          Effect.forkScoped
        )
        yield* Deferred.await(peer.entered)
        const interrupting = yield* Fiber.interrupt(consumer).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.succeed(peer.release, undefined)
        yield* Fiber.join(interrupting)
        const exit = yield* Fiber.await(consumer)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        yield* Queue.take(peer.sessions)
        yield* channel.assertQueue("post-interruption-barrier")
        while ((yield* Queue.size(peer.sessions)) > 0) yield* Queue.take(peer.sessions)
        yield* connection.reconnect
        const recovered = yield* Queue.take(peer.sessions)
        // Channel RPC is an ordered barrier after recovery: no abandoned consumer may be replayed.
        yield* channel.assertQueue("after-cancel-barrier")
        let consumeCount = 0
        while (true) {
          const method = yield* Queue.take(recovered.methods)
          if (method.classId === 60 && method.methodId === 20) consumeCount++
          if (method.classId === 50 && method.methodId === 10 && method.fields.queue === "after-cancel-barrier") break
        }
        expect(consumeCount).toBe(0)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")))
  }

  it.live("C-S76: consumer cleanup racing broker channel error is bounded and does not replay cancelled consumption", () =>
    Effect.gen(function*() {
      const broker = yield* makeBroker({ automaticTopology: true })
      const connection = yield* AMQPConnection.make(broker.factory)
      const channel = yield* connection.createChannel()
      const session = yield* Queue.take(broker.sessions)
      yield* channel.assertQueue("cleanup-race")
      const stream = yield* channel.consume("cleanup-race")
      const fiber = yield* Stream.runDrain(stream).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
      const registration = yield* nextMethod(session, 60, 20)
      yield* Effect.all([
        Fiber.interrupt(fiber),
        session.reply(registration.channel, 20, 40, {
          replyCode: 404,
          replyText: "NOT_FOUND - controlled consumer cleanup race",
          classId: 50,
          methodId: 10
        })
      ], { concurrency: 2 })
      yield* nextMethod(session, 20, 41)
      yield* connection.reconnect
      const recovered = yield* Queue.take(broker.sessions)
      yield* channel.assertQueue("cleanup-race-barrier")
      let consumeCount = 0
      while (true) {
        const method = yield* Queue.take(recovered.methods)
        if (method.classId === 60 && method.methodId === 20) consumeCount++
        if (method.classId === 50 && method.methodId === 10 && method.fields.queue === "cleanup-race-barrier") break
      }
      expect(consumeCount).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))
})
