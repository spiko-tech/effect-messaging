import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import type * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"
import type * as AMQPTopology from "../src/AMQPTopology.ts"
import { broker, decode, encode } from "./dependencies.ts"

// RabbitMQ Java client 5.37.0, 002777578d9138a9921ddfc4f9fb70556f8d4807:
// src/test/java/com/rabbitmq/client/test/functional/Transactions.java
const fixture = Effect.fnUntraced(function*() {
  const connection = yield* AMQPNodeConnection.make(broker)
  const publisher = yield* connection.createChannel({ confirm: true })
  const observer = yield* connection.createChannel()
  const transaction = yield* connection.createChannel()
  // RabbitMQ 4.3 denies transient non-exclusive queues; durability does not alter these transaction assertions.
  const queue = yield* publisher.assertQueue(`effect-official-tx-${randomUUID()}`, {
    durable: true,
    exclusive: false,
    autoDelete: false
  })
  // Cleanup must not depend on the transaction channel, which several scenarios close.
  yield* Effect.addFinalizer(() => publisher.deleteQueue(queue).pipe(Effect.ignore))
  return { publisher, observer, transaction, queue }
})

const receive = Effect.fnUntraced(function*(
  channel: AMQPChannel.AMQPChannel,
  queue: AMQPTopology.QueueName,
  body: string
) {
  const result = yield* channel.get(queue)
  expect(Option.isSome(result)).toBe(true)
  const message = Option.getOrThrow(result)
  expect(message.content).toEqual(encode(body))
  return message
})

describe("official RabbitMQ transaction behavior", () => {
  it.live("recover preserves a staged ack across rollback and re-ack", () =>
    Effect.gen(function*() {
      const { observer, publisher, queue, transaction } = yield* fixture()
      // Confirmation proves routing before the independent transaction channel retrieves it.
      yield* publisher.sendToQueue(queue, encode("staged-ack"))
      yield* transaction.txSelect()
      const original = yield* receive(transaction, queue, "staged-ack")
      yield* transaction.ack(original)
      yield* transaction.recover()
      // Recover-ok and GetEmpty are broker barriers, not a timed absence assertion.
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      yield* transaction.txRollback()
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      yield* transaction.ack(original)
      yield* transaction.txCommit()
      yield* transaction.close
      expect(yield* observer.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")), 15000)

  it.live("rollback restores mixed ack, nack and reject receipts", () =>
    Effect.gen(function*() {
      const { observer, publisher, queue, transaction } = yield* fixture()
      for (const body of ["acked", "nacked", "rejected"]) {
        yield* publisher.sendToQueue(queue, encode(body))
      }
      yield* transaction.txSelect()
      const acked = yield* receive(transaction, queue, "acked")
      const nacked = yield* receive(transaction, queue, "nacked")
      const rejected = yield* receive(transaction, queue, "rejected")
      yield* transaction.ack(acked)
      yield* transaction.nack(nacked, false, false)
      yield* transaction.reject(rejected, true)
      yield* transaction.txRollback()
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      // Reverse both negative outcomes using the same original receipts, then commit.
      yield* transaction.ack(acked)
      yield* transaction.nack(nacked, false, true)
      yield* transaction.reject(rejected, false)
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      yield* transaction.txCommit()
      const redelivered = yield* receive(observer, queue, "nacked")
      expect(redelivered.fields.redelivered).toBe(true)
      yield* observer.ack(redelivered)
      yield* transaction.close
      expect(yield* observer.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")), 15000)

  it.live("close discards a broker-admitted uncommitted publication", () =>
    Effect.gen(function*() {
      const { observer, queue, transaction } = yield* fixture()
      yield* transaction.txSelect()
      yield* transaction.sendToQueue(queue, encode("never-committed"))
      // The same-channel DeclareOk proves the broker processed the preceding publication.
      expect((yield* transaction.checkQueue(queue)).messageCount).toBe(0)
      expect(yield* observer.get(queue)).toEqual(Option.none())
      yield* transaction.close
      expect(yield* observer.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")), 15000)

  it.live("close requeues staged acknowledgements and untouched deliveries", () =>
    Effect.gen(function*() {
      const { observer, publisher, queue, transaction } = yield* fixture()
      for (const body of ["acked-without-commit", "unacked"]) {
        yield* publisher.sendToQueue(queue, encode(body))
      }
      yield* transaction.txSelect()
      const acknowledged = yield* receive(transaction, queue, "acked-without-commit")
      yield* transaction.ack(acknowledged)
      yield* receive(transaction, queue, "unacked")
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      yield* transaction.close
      const bodies = new Set<string>()
      for (let i = 0; i < 2; i++) {
        const result = yield* observer.get(queue)
        expect(Option.isSome(result)).toBe(true)
        const message = Option.getOrThrow(result)
        expect(message.fields.redelivered).toBe(true)
        bodies.add(decode(message.content))
        yield* observer.ack(message)
      }
      expect(bodies).toEqual(new Set(["acked-without-commit", "unacked"]))
      expect(yield* observer.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")), 15000)

  it.live("noAck get remains removed after rollback and channel close", () =>
    Effect.gen(function*() {
      const { observer, publisher, queue, transaction } = yield* fixture()
      yield* publisher.sendToQueue(queue, encode("auto-ack"))
      yield* transaction.txSelect()
      const result = yield* transaction.get(queue, { noAck: true })
      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrThrow(result).content).toEqual(encode("auto-ack"))
      yield* transaction.txRollback()
      expect(yield* transaction.get(queue)).toEqual(Option.none())
      yield* transaction.close
      expect(yield* observer.get(queue)).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")), 15000)
})
