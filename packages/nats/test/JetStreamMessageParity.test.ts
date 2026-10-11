import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import type * as Scope from "effect/Scope"
import * as JetStreamClient from "../src/JetStreamClient.ts"
import * as JetStreamManager from "../src/JetStreamManager.ts"
import * as JetStreamMessage from "../src/JetStreamMessage.ts"
import { AckPolicy, StorageType } from "../src/JetStreamTypes.ts"
import * as NATSConnection from "../src/NATSConnection.ts"
import * as NATSMessage from "../src/NATSMessage.ts"

const timestamp = "1700000000123456789"
const frame = (reply: string, data = "body", sid = 1) =>
  NATSMessage.make({ subject: "orders", sid, data: new TextEncoder().encode(data), reply }, () => Effect.void)
const withMessage = <A, E, R>(
  policy: typeof AckPolicy[keyof typeof AckPolicy],
  run: (
    message: JetStreamMessage.JetStreamMessage,
    connection: NATSConnection.NATSConnection
  ) => Effect.Effect<A, E, R>,
  timeout = 5000,
  redirectAcknowledgements = false
) =>
  Effect.gen(function*() {
    const native = yield* NATSConnection.NATSConnection
    const connection: NATSConnection.NATSConnection = redirectAcknowledgements
      ? {
        ...native,
        request: (subject, payload, options) =>
          native.request(
            subject.startsWith("$JS.ACK.") ? `$JS.ACK.synthetic.consumer.1.1.1.${timestamp}.0` : subject,
            payload,
            options
          )
      }
      : native
    const manager = JetStreamManager.make(connection)
    const client = JetStreamClient.make(connection, { timeout })
    const name = `MESSAGE_${crypto.randomUUID().replaceAll("-", "")}`
    const subject = `${name}.orders`
    yield* Effect.acquireRelease(
      manager.streams.add({ name, subjects: [subject], storage: StorageType.Memory, allow_direct: true }),
      () => manager.streams.delete(name).pipe(Effect.orDie)
    )
    yield* manager.consumers.add(name, { durable_name: "consumer", ack_policy: policy })
    yield* client.publish(subject, "hello")
    const consumer = yield* client.consumers.get(name, "consumer")
    const message = yield* consumer.next()
    expect(Option.isSome(message)).toBe(true)
    return yield* run(Option.getOrThrow(message), connection)
  }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" })))

const assertTimeout = (
  message: JetStreamMessage.JetStreamMessage,
  connection: NATSConnection.NATSConnection,
  timeout?: number,
  inherited = 5000
): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function*() {
    const reply = `$JS.ACK.synthetic.consumer.1.1.1.${timestamp}.0`
    yield* connection.subscribe(reply)
    yield* connection.flush
    const started = Date.now()
    const error = yield* message.ackAck(timeout === undefined ? {} : { timeout }).pipe(Effect.flip)
    expect(error._tag).toBe("JetStreamMessageError")
    expect(error.cause).toMatchObject({ _tag: "NATSConnectionError", code: "timeout" })
    const elapsed = Date.now() - started
    const expected = timeout ?? inherited
    expect(elapsed).toBeGreaterThanOrEqual(expected - 50)
    expect(elapsed).toBeLessThan(expected + 500)
    expect(message.seq).toBe(1)
  })

describe("Official JetStream message v3.4.0 cases", () => {
  it.live("jsmsg - parse", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const message = yield* JetStreamMessage.make(
        frame(`$JS.ACK.streamname.consumername.2.3.4.${timestamp}.100`),
        connection
      )
      expect(message.info).toMatchObject({
        stream: "streamname",
        consumer: "consumername",
        deliveryCount: 2,
        streamSequence: 3,
        deliverySequence: 4,
        pending: 100
      })
    }).pipe(Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" }))))

  it.live("jsmsg - parse long", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const message = yield* JetStreamMessage.make(
        frame(`$JS.ACK.domain.account.streamname.consumername.2.3.4.${timestamp}.100.rand`),
        connection
      )
      expect(message.info).toMatchObject({
        domain: "domain",
        account_hash: "account",
        stream: "streamname",
        consumer: "consumername",
        deliveryCount: 2,
        streamSequence: 3,
        pending: 100
      })
    }).pipe(Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" }))))

  it.live("jsmsg - parse rejects subject is not 9 tokens", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const chunks = "$JS.ACK.stream.consumer.1.2.3.4.5.6.7.8.9.10".split(".")
      for (let count = 1; count <= chunks.length; count++) {
        const valid = yield* JetStreamMessage.make(frame(chunks.slice(0, count).join(".")), connection).pipe(
          Effect.match({ onSuccess: () => true, onFailure: () => false })
        )
        expect(valid).toBe(count === 9 || count >= 11)
      }
    }).pipe(Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" }))))

  it.live("jsmsg - acks", () =>
    Effect.gen(function*() {
      const connection = yield* NATSConnection.NATSConnection
      const stream = `synthetic_${crypto.randomUUID().replaceAll("-", "")}`
      const replies = yield* connection.subscribe(`$JS.ACK.${stream}.consumer.>`)
      const collected = yield* replies.stream.pipe(
        Stream.take(4),
        Stream.mapEffect((message) => message.string),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* connection.flush
      const messages = yield* Effect.forEach([1, 2, 3, 4], (sequence) =>
        JetStreamMessage.make(frame(`$JS.ACK.${stream}.consumer.1.${sequence}.${sequence}.${timestamp}.0`), connection))
      yield* messages[0].nak()
      yield* messages[1].working
      yield* messages[2].term()
      yield* messages[3].ack
      yield* connection.flush
      expect(yield* Fiber.join(collected)).toEqual(["-NAK", "+WPI", "+TERM", "+ACK"])
    }).pipe(Effect.scoped, Effect.provide(NATSConnection.layerNode({ servers: "localhost:4222" }))))

  it.live("jsmsg - no ack consumer is ackAck 503", () =>
    withMessage(AckPolicy.None, (message) =>
      Effect.gen(function*() {
        const error = yield* message.ackAck().pipe(Effect.flip)
        expect(error._tag).toBe("JetStreamMessageError")
        expect(error.cause).toMatchObject({ _tag: "NATSConnectionError", code: "no_responders" })
      })))

  it.live("jsmsg - explicit consumer ackAck", () =>
    withMessage(AckPolicy.Explicit, (message) =>
      Effect.gen(function*() {
        expect(yield* message.ackAck()).toBe(true)
        expect(yield* message.ackAck()).toBe(false)
      })))

  it.live("jsmsg - explicit consumer ackAck timeout", () =>
    withMessage(AckPolicy.None, (message, connection) => assertTimeout(message, connection, 1000), 5000, true))
  it.live("jsmsg - ackAck js options timeout", () =>
    withMessage(
      AckPolicy.None,
      (message, connection) => assertTimeout(message, connection, undefined, 1500),
      1500,
      true
    ))
  it.live("jsmsg - ackAck legacy timeout", () =>
    withMessage(
      AckPolicy.None,
      (message, connection) => assertTimeout(message, connection, undefined, 1500),
      1500,
      true
    ))

  it.live("jsmsg - time and timestamp", () =>
    withMessage(AckPolicy.None, (message) =>
      Effect.sync(() => {
        expect(message.time).toBeInstanceOf(Date)
        expect(message.time.toISOString()).toBe(message.timestamp)
      })))

  it.live("jsmsg - reply/sid", () =>
    withMessage(AckPolicy.None, (message) =>
      Effect.sync(() => {
        expect(Option.isSome(message.reply)).toBe(true)
        expect(Option.getOrThrow(message.reply)).not.toBe("")
        expect(message.sid).toBeGreaterThan(0)
        expect(message.data).toEqual(new TextEncoder().encode("hello"))
      })))
})
