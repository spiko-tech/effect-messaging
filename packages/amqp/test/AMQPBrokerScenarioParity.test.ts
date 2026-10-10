import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { randomUUID } from "node:crypto"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTopology from "../src/AMQPTopology.ts"
import { expectFailure } from "./assertions.ts"
import { broker, encode, testConfirmChannel } from "./dependencies.ts"

const name = () => `effect-scenario-${randomUUID()}`

const diagnostic = (replyCode: number, classId: number, methodId: number, text: string) => ({
  _tag: "AMQPChannelError",
  replyCode,
  classId,
  methodId,
  reason: expect.stringContaining(text)
})

const exchange = Effect.fnUntraced(function*(channel: AMQPChannel.AMQPChannel, type = "direct", internal = false) {
  const exchange = name()
  const cleanup = yield* channel.connection.createChannel()
  yield* Effect.addFinalizer(() => cleanup.deleteExchange(exchange).pipe(Effect.ignore))
  yield* channel.assertExchange(exchange, type, { durable: false, internal })
  return exchange
})

const expectContent = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  queue: AMQPTopology.QueueName,
  content: Uint8Array
) {
  const received = yield* channel.get(queue)
  expect(Option.isSome(received)).toBe(true)
  if (Option.isNone(received)) return
  expect(received.value.content).toEqual(content)
  yield* channel.ack(received.value)
})

describe("AMQP pinned broker scenario parity", () => {
  for (const operation of ["get", "consume"] as const) {
    const id = operation === "get" ? "CA18 CB27" : "CB28"
    it.live(`${id}: empty-name ${operation} preserves NOT_FOUND broker diagnostics`, () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const attempted = operation === "get"
          ? channel.get("").pipe(Effect.asVoid)
          : channel.consume("").pipe(Effect.asVoid)
        expectFailure(
          yield* attempted.pipe(Effect.exit),
          diagnostic(404, 60, operation === "get" ? 70 : 20, "NOT_FOUND")
        )
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.sendToQueue(queue, encode("after-empty-name-error"))
        yield* expectContent(channel, queue, encode("after-empty-name-error"))
      }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)
  }

  for (const mismatch of [false, true]) {
    it.live(
      mismatch
        ? "C-S75: mismatch fails while a queued valid declaration succeeds after recovery"
        : "C-S73 C-S74: missing passive fails while a queued valid declaration succeeds after recovery",
      () =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          const queueName = name()
          const validName = name()
          const cleanup = yield* channel.connection.createChannel()
          yield* Effect.addFinalizer(() => cleanup.deleteQueue(queueName).pipe(Effect.ignore))
          yield* Effect.addFinalizer(() => cleanup.deleteQueue(validName).pipe(Effect.ignore))
          if (mismatch) yield* channel.assertQueue(queueName, { durable: true, autoDelete: true })
          const invalid = mismatch
            ? channel.assertQueue(queueName, { durable: true, autoDelete: false })
            : channel.checkQueue(queueName)
          const rejected = yield* invalid.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
          const sibling = yield* channel.assertQueue(validName, { durable: true }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true })
          )
          const expected = diagnostic(mismatch ? 406 : 404, 50, 10, mismatch ? "PRECONDITION_FAILED" : "NOT_FOUND")
          expectFailure(yield* Fiber.join(rejected), expected)
          const siblingResult = yield* Fiber.join(sibling)
          expect(Exit.isSuccess(siblingResult)).toBe(true)
          if (Exit.isFailure(siblingResult)) return
          const valid = siblingResult.value
          expect(valid.queue).toBe(validName)
          yield* channel.sendToQueue(valid, encode("after-concurrent-error"))
          yield* expectContent(channel, valid, encode("after-concurrent-error"))
        }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
      15000
    )
  }

  for (const closing of [false, true]) {
    it.live(
      closing
        ? "R-B15 native seam: oversized control RPC plus queued valid RPC and close are bounded and release capacity"
        : "R-B14 native seam: oversized control RPC does not poison a queued valid RPC or channel capacity",
      () =>
        Effect.gen(function*() {
          const connection = yield* AMQPConnection.AMQPConnection
          const channel = yield* connection.createChannel()
          const malformed = yield* channel.assertQueue("x".repeat(256), { exclusive: true }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true })
          )
          const queued = yield* channel.assertQueue("", { exclusive: true }).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true })
          )
          const closed = closing ? yield* channel.close.pipe(Effect.forkChild({ startImmediately: true })) : undefined
          expectFailure(yield* Fiber.join(malformed), {
            _tag: "AMQPProtocolError",
            reason: expect.stringContaining("Short string exceeds 255 UTF-8 bytes")
          })
          const queuedResult = yield* Fiber.join(queued)
          // Native close drains the already queued valid RPC; an encoder failure never poisons it.
          expect(Exit.isSuccess(queuedResult)).toBe(true)
          if (closed !== undefined) yield* Fiber.join(closed)
          else yield* channel.close
          const replacement = yield* connection.createChannel({ confirm: true })
          const queue = yield* replacement.assertQueue("", { exclusive: true })
          yield* replacement.sendToQueue(queue, encode("capacity-reused"))
          yield* expectContent(replacement, queue, encode("capacity-reused"))
          yield* replacement.close
        }).pipe(
          Effect.scoped,
          Effect.provide(AMQPNodeConnection.layer({ ...broker, channelMax: 1 })),
          Effect.timeout("10 seconds")
        ),
      15000
    )
  }

  it.live(
    "C-S25: queue deletion allows a fresh declaration with changed exclusive options",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queueName = name()
        const cleanup = yield* channel.connection.createChannel()
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(queueName).pipe(Effect.ignore))
        const first = yield* channel.assertQueue(queueName, { durable: true, autoDelete: true, exclusive: false })
        yield* channel.deleteQueue(first)
        const second = yield* channel.assertQueue(queueName, { durable: true, autoDelete: true, exclusive: true })
        expect(second).not.toBe(first)
        expect(second.queue).toBe(queueName)
        yield* channel.sendToQueue(second, encode("fresh"))
        yield* expectContent(channel, second, encode("fresh"))
        yield* channel.deleteQueue(second)
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "C-S27: ifEmpty rejection retains queue content and routing topology until empty deletion succeeds",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel)
        const queueName = name()
        const cleanup = yield* channel.connection.createChannel()
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(queueName).pipe(Effect.ignore))
        const queue = yield* channel.assertQueue(queueName, { durable: true })
        yield* channel.bindQueue(queue, source, "key")
        yield* channel.publish(source, "key", encode("blocker"))
        expectFailure(
          yield* channel.deleteQueue(queue, { ifEmpty: true }).pipe(Effect.exit),
          diagnostic(406, 50, 40, "PRECONDITION_FAILED")
        )
        expect((yield* channel.checkQueue(queue)).queue).toBe(queueName)
        yield* expectContent(channel, queue, encode("blocker"))
        yield* channel.publish(source, "key", encode("retained-binding"))
        yield* expectContent(channel, queue, encode("retained-binding"))
        expect(yield* channel.deleteQueue(queue, { ifEmpty: true })).toEqual({ messageCount: 0 })
        expectFailure(yield* channel.checkQueue(queue).pipe(Effect.exit), diagnostic(404, 50, 10, "NOT_FOUND"))
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "ifUnused rejection retains an active consumer until cancellation permits deletion",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queueName = name()
        const cleanup = yield* channel.connection.createChannel()
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(queueName).pipe(Effect.ignore))
        const queue = yield* channel.assertQueue(queueName, { durable: true })
        const consumerTag = name()
        const stream = yield* channel.consume(queue, { consumerTag })
        const consuming = yield* stream.pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }))
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
        expectFailure(
          yield* channel.deleteQueue(queue, { ifUnused: true }).pipe(Effect.exit),
          diagnostic(406, 50, 40, "PRECONDITION_FAILED")
        )
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(1)
        yield* channel.cancel(consumerTag)
        yield* Fiber.join(consuming)
        expect((yield* channel.checkQueue(queue)).consumerCount).toBe(0)
        expect(yield* channel.deleteQueue(queue, { ifUnused: true })).toEqual({ messageCount: 0 })
        expectFailure(yield* channel.checkQueue(queue).pipe(Effect.exit), diagnostic(404, 50, 10, "NOT_FOUND"))
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live("R-B31: concurrent declare consume declare RPCs retain reply ordering", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const firstName = name()
      const secondName = name()
      const first = yield* channel.assertQueue(firstName, { exclusive: true }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      const consumer = yield* channel.consume(firstName, { consumerTag: "red" }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      const second = yield* channel.assertQueue(secondName, { exclusive: true }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      expect((yield* Fiber.join(first)).queue).toBe(firstName)
      expect((yield* Fiber.join(second)).queue).toBe(secondName)
      const stream = yield* Fiber.join(consumer)
      const receiving = yield* stream.pipe(
        Stream.take(1),
        Stream.mapEffect((message) => channel.ack(message).pipe(Effect.as(message))),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* channel.sendToQueue(firstName, encode("ordered"))
      expect((yield* Fiber.join(receiving))[0].content).toEqual(encode("ordered"))
      expect((yield* channel.checkQueue(secondName)).queue).toBe(secondName)
    }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)

  it.live(
    "C-T70: two then three concurrent queue binding RPCs complete and preserve routing",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel, "fanout")
        const queue = yield* channel.assertQueue("", { exclusive: true })
        for (const routingKeys of [["foo:*", "bar:*"], ["baz:*", "qux:*", "quux:*"]]) {
          yield* Effect.forEach(routingKeys, (key) => channel.bindQueue(queue, source, key), {
            concurrency: "unbounded"
          })
        }
        expect((yield* channel.checkQueue(queue)).queue).toBe(queue.queue)
        yield* channel.publish(source, "anything", encode("parallel-bound"))
        yield* expectContent(channel, queue, encode("parallel-bound"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "CA11 R-B23: confirmed missing-exchange publish exposes broker 404 then valid publish recovers without replay",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const returned = yield* channel.returns.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* channel.publish("", name(), encode("returned"), { mandatory: true })
        expect((yield* Fiber.join(returned))[0].content).toEqual(encode("returned"))
        expectFailure(yield* channel.publish(name(), queue.queue, encode("failed")).pipe(Effect.exit), {
          _tag: "AMQPPublishError",
          outcome: "Unknown",
          cause: expect.objectContaining(diagnostic(404, 60, 40, "NOT_FOUND"))
        })
        yield* channel.sendToQueue(queue, encode("valid"))
        yield* expectContent(channel, queue, encode("valid"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
        yield* channel.connection.reconnect
        expect(yield* channel.get(queue)).toEqual(Option.none())
        yield* channel.sendToQueue(queue, encode("after-connection-recovery"))
        yield* expectContent(channel, queue, encode("after-connection-recovery"))
        yield* channel.close
        expectFailure(yield* channel.sendToQueue(queue, encode("after-close")).pipe(Effect.exit), {
          _tag: "AMQPPublishError",
          outcome: "NotSent",
          cause: expect.objectContaining({ _tag: "AMQPChannelError", reason: expect.stringContaining("closed") })
        })
      }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "R-B10: pipelined confirmed publishes acknowledge the prefix and fail the middle and suffix as Unknown",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const missing = name()
        const pending = yield* Effect.forEach([
          channel.publish("", missing, encode("first")),
          channel.publish(missing, missing, encode("middle")),
          channel.publish("", missing, encode("last"))
        ], (publish) => publish.pipe(Effect.exit, Effect.forkChild({ startImmediately: true })))
        const results = yield* Effect.forEach(pending, Fiber.join)
        expect(Exit.isSuccess(results[0])).toBe(true)
        for (const result of results.slice(1)) {
          expectFailure(result, {
            _tag: "AMQPPublishError",
            outcome: "Unknown",
            cause: expect.objectContaining(diagnostic(404, 60, 40, "NOT_FOUND"))
          })
        }
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.sendToQueue(queue, encode("after-pipeline"))
        yield* expectContent(channel, queue, encode("after-pipeline"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "R-B11: nonconfirm missing-exchange publish exposes the broker error through public connection changes",
    () =>
      Effect.gen(function*() {
        const confirmChannel = yield* AMQPChannel.AMQPChannel
        const channel = yield* confirmChannel.connection.createChannel()
        const generation = (yield* channel.connection.state).generation
        const errorState = yield* channel.connection.changes.pipe(
          Stream.filter((state) => state.error?._tag === "AMQPChannelError" && state.error.replyCode === 404),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* channel.publish(name(), "key", encode("nonconfirm"))
        const [state] = yield* Fiber.join(errorState)
        expect(state.state).toBe("Ready")
        expect(state.generation).toBe(generation)
        expect(state.error).toEqual(expect.objectContaining(diagnostic(404, 60, 40, "NOT_FOUND")))
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.sendToQueue(queue, encode("after-nonconfirm"))
        yield* expectContent(channel, queue, encode("after-nonconfirm"))
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "C-S89: a routed mandatory publish produces no return before an ordered unroutable sentinel",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queue = yield* channel.assertQueue("", { exclusive: true })
        const returned = yield* channel.returns.pipe(
          Stream.takeUntil((message) => message.properties.messageId === "barrier"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* channel.sendToQueue(queue, encode("routed"), { mandatory: true, messageId: "routed" })
        yield* channel.publish("", name(), encode("sentinel"), { mandatory: true, messageId: "barrier" })
        const messages = yield* Fiber.join(returned)
        expect(messages).toHaveLength(1)
        expect(messages[0].properties.messageId).toBe("barrier")
        expect(messages[0].fields.replyCode).toBe(312)
        yield* expectContent(channel, queue, encode("routed"))
      }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live("CA19 C-S35: fanout routes identical bytes to every bound queue", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const source = yield* exchange(channel, "fanout")
      const queues = yield* Effect.forEach([1, 2], () => channel.assertQueue("", { exclusive: true }))
      for (const queue of queues) yield* channel.bindQueue(queue, source, "ignored")
      const content = new Uint8Array([0, 255, 1, 128, 0])
      yield* channel.publish(source, "any", content)
      for (const queue of queues) {
        yield* expectContent(channel, queue, content)
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)

  it.live(
    "CA22: direct source routes through an internal fanout exchange to an acknowledged consumer",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel, "direct")
        const destination = yield* exchange(channel, "fanout", true)
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.bindExchange(destination, source, "test.routing.key")
        yield* channel.bindQueue(queue, destination, "")
        const content = new Uint8Array([0, 255, 32, 128])
        const stream = yield* channel.consume(queue)
        const receiving = yield* stream.pipe(
          Stream.take(1),
          Stream.mapEffect((message) => channel.ack(message).pipe(Effect.as(message))),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* channel.publish(source, "test.routing.key", content)
        const [message] = yield* Fiber.join(receiving)
        expect(message.content).toEqual(content)
        expect(message.fields.exchange).toBe(source)
        expect(message.fields.routingKey).toBe("test.routing.key")
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live("C-S36: topic events.# routes matching events and excludes other prefixes", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const source = yield* exchange(channel, "topic")
      const queue = yield* channel.assertQueue("", { exclusive: true })
      yield* channel.bindQueue(queue, source, "events.#")
      yield* channel.publish(source, "events.user.created", encode("matching"))
      yield* channel.publish(source, "other.created", encode("excluded"))
      yield* expectContent(channel, queue, encode("matching"))
      expect(yield* channel.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)

  it.live(
    "C-T17: reserved amq.* queue names report ACCESS_REFUSED with declaration diagnostics",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        expectFailure(
          yield* channel.assertQueue(`amq.${randomUUID()}`, { exclusive: true }).pipe(Effect.exit),
          diagnostic(403, 50, 10, "ACCESS_REFUSED")
        )
        expect((yield* channel.assertQueue("", { exclusive: true })).queue).not.toBe("")
      }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live("C-T31: unknown exchange types surface the broker PRECONDITION_FAILED error", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const errors = yield* channel.connection.changes.pipe(
        Stream.filter((state) => state.error?._tag === "AMQPChannelError" && state.error.classId === 40),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      expectFailure(
        yield* channel.assertExchange(name(), "not-a-valid-exchange-type").pipe(Effect.exit),
        diagnostic(406, 40, 10, "unknown exchange type")
      )
      expect((yield* Fiber.join(errors))[0].error).toEqual(
        expect.objectContaining(diagnostic(406, 40, 10, "unknown exchange type"))
      )
      expect((yield* channel.assertQueue("", { exclusive: true })).queue).not.toBe("")
    }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)

  it.live(
    "C-T32: confirmed publish succeeds before exchange deletion and fails with NOT_FOUND afterward",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel, "fanout")
        yield* channel.checkExchange(source)
        yield* channel.publish(source, "rk", encode("body"))
        yield* channel.deleteExchange(source)
        expectFailure(yield* channel.publish(source, "rk", encode("body")).pipe(Effect.exit), {
          _tag: "AMQPPublishError",
          outcome: "Unknown",
          cause: expect.objectContaining(diagnostic(404, 60, 40, "NOT_FOUND"))
        })
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.sendToQueue(queue, encode("after-deleted-exchange"))
        yield* expectContent(channel, queue, encode("after-deleted-exchange"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  for (
    const scenario of [
      { id: "CA08", operation: "checkQueue", classId: 50, methodId: 10 },
      { id: "CA09", operation: "checkExchange", classId: 40, methodId: 10 },
      { id: "CA18 CB27", operation: "get", classId: 60, methodId: 70 },
      { id: "CB28", operation: "consume", classId: 60, methodId: 20 }
    ] as const
  ) {
    it.live(
      `${scenario.id}: missing ${scenario.operation} preserves NOT_FOUND broker diagnostics`,
      () =>
        Effect.gen(function*() {
          const channel = yield* AMQPChannel.AMQPChannel
          const missing = name()
          expectFailure(
            yield* channel[scenario.operation](missing).pipe(Effect.exit),
            diagnostic(404, scenario.classId, scenario.methodId, "NOT_FOUND")
          )
          const queue = yield* channel.assertQueue("", { exclusive: true })
          yield* channel.sendToQueue(queue, encode("recovered"))
          yield* expectContent(channel, queue, encode("recovered"))
        }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
      15000
    )
  }

  it.live(
    "CA10: mismatched exchange type preserves PRECONDITION_FAILED diagnostics and direct routing",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel)
        const queue = yield* channel.assertQueue("", { exclusive: true })
        yield* channel.bindQueue(queue, source, "key")
        expectFailure(
          yield* channel.assertExchange(source, "fanout", { durable: false }).pipe(Effect.exit),
          diagnostic(406, 40, 10, "PRECONDITION_FAILED")
        )
        yield* channel.publish(source, "key", encode("direct"))
        yield* expectContent(channel, queue, encode("direct"))
        yield* channel.publish(source, "other", encode("not-fanout"))
        expect(yield* channel.get(queue)).toEqual(Option.none())
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live("CA12: deleting a queue makes the immediate passive check report NOT_FOUND", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queue = yield* channel.assertQueue("", { exclusive: true })
      const inspector = yield* channel.connection.createChannel()
      const generation = (yield* channel.connection.state).generation
      expect(yield* channel.deleteQueue(queue)).toEqual({ messageCount: 0 })
      expectFailure(yield* inspector.checkQueue(queue).pipe(Effect.exit), diagnostic(404, 50, 10, "NOT_FOUND"))
      expect((yield* channel.connection.state).generation).toBe(generation)
      yield* channel.connection.reconnect
      expectFailure(yield* inspector.checkQueue(queue).pipe(Effect.exit), diagnostic(404, 50, 10, "NOT_FOUND"))
    }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)

  it.live(
    "CA13: deleting an exchange makes the immediate passive check report NOT_FOUND",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const source = yield* exchange(channel)
        const inspector = yield* channel.connection.createChannel()
        const generation = (yield* channel.connection.state).generation
        yield* channel.deleteExchange(source)
        expectFailure(yield* inspector.checkExchange(source).pipe(Effect.exit), diagnostic(404, 40, 10, "NOT_FOUND"))
        expect((yield* channel.connection.state).generation).toBe(generation)
        yield* channel.connection.reconnect
        expectFailure(yield* inspector.checkExchange(source).pipe(Effect.exit), diagnostic(404, 40, 10, "NOT_FOUND"))
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )

  it.live(
    "CA07: mismatched queue reassert preserves PRECONDITION_FAILED diagnostics and original topology",
    () =>
      Effect.gen(function*() {
        const channel = yield* AMQPChannel.AMQPChannel
        const queueName = name()
        const cleanup = yield* channel.connection.createChannel()
        yield* Effect.addFinalizer(() => cleanup.deleteQueue(queueName).pipe(Effect.ignore))
        const queue = yield* channel.assertQueue(queueName, { durable: true, autoDelete: true })
        expectFailure(
          yield* channel.assertQueue(queueName, { durable: true, autoDelete: false }).pipe(Effect.exit),
          diagnostic(406, 50, 10, "PRECONDITION_FAILED")
        )
        yield* channel.sendToQueue(queue, encode("original-queue"))
        yield* expectContent(channel, queue, encode("original-queue"))
        expect((yield* channel.checkQueue(queue)).queue).toBe(queueName)
      }).pipe(Effect.scoped, Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")),
    15000
  )
  it.live("CA05: assert and check a named queue return its exact name", () =>
    Effect.gen(function*() {
      const channel = yield* AMQPChannel.AMQPChannel
      const queueName = name()
      const queue = yield* channel.assertQueue(queueName, { exclusive: true })
      expect(queue.queue).toBe(queueName)
      expect(yield* channel.checkQueue(queueName)).toEqual({ queue: queueName, messageCount: 0, consumerCount: 0 })
    }).pipe(Effect.provide(testConfirmChannel), Effect.timeout("10 seconds")), 15000)
})
