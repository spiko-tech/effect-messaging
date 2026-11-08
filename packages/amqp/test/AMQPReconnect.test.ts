import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Queue, Schedule } from "effect"
import { EventEmitter } from "node:events"
import { vi } from "vitest"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import * as AMQPPublisher from "../src/AMQPPublisher.ts"
import * as AMQPSubscriber from "../src/AMQPSubscriber.ts"
import * as AMQPSubscriberResponse from "../src/AMQPSubscriberResponse.ts"

const QUEUE = "orders"

interface RecordedPublish {
  readonly connectionId: number
  readonly exchange: string
  readonly routingKey: string
  readonly body: string
}

interface PendingDelivery {
  readonly exchange: string
  readonly routingKey: string
  readonly body: string
}

interface Delivery {
  readonly content: Buffer
  readonly fields: {
    readonly deliveryTag: number
    readonly redelivered: false
    readonly exchange: string
    readonly routingKey: string
    readonly consumerTag: string
  }
  readonly properties: {
    readonly headers: Record<string, never>
    readonly messageId: undefined
    readonly correlationId: undefined
  }
}

const serverProperties = {
  host: "mock",
  port: "5672",
  product: "mock-amqp",
  version: "0",
  platform: "test",
  information: "synthetic"
}

const harness = vi.hoisted(() => ({
  connect: undefined as (() => Promise<EventEmitter>) | undefined
}))

vi.mock("amqplib", () => ({
  connect: () => {
    const connect = harness.connect
    if (connect === undefined) {
      return Promise.reject(new Error("AMQP test broker is not installed"))
    }
    return connect()
  }
}))

class FakeChannel extends EventEmitter {
  closed = false
  private tags = 0
  deliveryTag = 0
  readonly consumers = new Map<
    string,
    { readonly queue: string; readonly onMessage: (message: Delivery | null) => void }
  >()

  readonly connection: { readonly serverProperties: typeof serverProperties }

  constructor(private readonly owner: FakeConnection) {
    super()
    this.connection = owner.connection
  }

  prefetch() {
    return Promise.resolve({})
  }

  consume(queue: string, onMessage: (message: Delivery | null) => void) {
    if (this.closed || this.owner.closed) {
      return Promise.reject(new Error("Channel closed"))
    }
    const consumerTag = `ctag-${this.owner.id}-${++this.tags}`
    this.consumers.set(consumerTag, { queue, onMessage })
    broker.consumeQueues.push(queue)
    flush(queue)
    return Promise.resolve({ consumerTag })
  }

  cancel(consumerTag: string) {
    this.consumers.delete(consumerTag)
    return Promise.resolve({})
  }

  publish(exchange: string, routingKey: string, content: Uint8Array) {
    if (this.closed || this.owner.closed || broker.suspended) {
      throw new Error("Channel closed")
    }
    const body = Buffer.from(content).toString()
    broker.publishes.push({
      connectionId: this.owner.id,
      exchange,
      routingKey,
      body
    })
    const queued = broker.pending.get(routingKey) ?? []
    queued.push({ exchange, routingKey, body })
    broker.pending.set(routingKey, queued)
    flush(routingKey)
    return true
  }

  ack() {}

  nack() {}

  reject() {}

  close() {
    if (this.closed) {
      return Promise.resolve()
    }
    this.closed = true
    this.emit("close")
    return Promise.resolve()
  }
}

class FakeConnection extends EventEmitter {
  closed = false
  readonly channels: Array<FakeChannel> = []
  readonly connection = { serverProperties }

  constructor(readonly id: number) {
    super()
  }

  createChannel() {
    if (this.closed) {
      return Promise.reject(new Error("Connection closed"))
    }
    const channel = new FakeChannel(this)
    this.channels.push(channel)
    return Promise.resolve(channel)
  }

  createConfirmChannel() {
    return this.createChannel()
  }

  updateSecret() {
    return Promise.resolve()
  }

  close() {
    if (this.closed) {
      return Promise.resolve()
    }
    this.closed = true
    for (const channel of this.channels) {
      if (!channel.closed) {
        channel.closed = true
        channel.emit("close")
      }
    }
    this.emit("close")
    return Promise.resolve()
  }
}

const broker = {
  connects: 0,
  current: undefined as FakeConnection | undefined,
  consumeQueues: [] as Array<string>,
  publishes: [] as Array<RecordedPublish>,
  pending: new Map<string, Array<PendingDelivery>>(),
  reconnectStarted: false,
  suspended: false,
  hold: undefined as Promise<void> | undefined,
  releaseHold: () => {},
  reset() {
    this.connects = 0
    this.current = undefined
    this.consumeQueues = []
    this.publishes = []
    this.pending = new Map()
    this.reconnectStarted = false
    this.suspended = false
    this.hold = undefined
    this.releaseHold = () => {}
  },
  armHold() {
    this.reconnectStarted = false
    this.suspended = false
    this.hold = new Promise((resolve) => {
      this.releaseHold = () => {
        this.suspended = false
        this.hold = undefined
        resolve()
      }
    })
  }
}

const flush = (queue: string) => {
  const waiting = broker.pending.get(queue)
  const connection = broker.current
  if (waiting === undefined || waiting.length === 0 || connection === undefined || connection.closed) {
    return
  }
  const channel = connection.channels.find((item) => !item.closed && item.consumers.size > 0)
  if (channel === undefined) {
    return
  }
  const remaining: Array<PendingDelivery> = []
  for (const message of waiting) {
    const consumer = [...channel.consumers.entries()].find(([, registered]) => registered.queue === message.routingKey)
    if (consumer === undefined) {
      remaining.push(message)
      continue
    }
    const [consumerTag, registered] = consumer
    registered.onMessage({
      content: Buffer.from(message.body),
      fields: {
        deliveryTag: ++channel.deliveryTag,
        redelivered: false,
        exchange: message.exchange,
        routingKey: message.routingKey,
        consumerTag
      },
      properties: {
        headers: {},
        messageId: undefined,
        correlationId: undefined
      }
    })
  }
  broker.pending.set(queue, remaining)
}

harness.connect = async () => {
  broker.connects += 1
  if (broker.connects > 1) {
    broker.reconnectStarted = true
    if (broker.hold !== undefined) {
      await broker.hold
    }
  }
  const connection = new FakeConnection(broker.connects)
  broker.current = connection
  return connection
}

const waitFor = (label: string, predicate: () => boolean) =>
  Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const check = () => {
        if (predicate()) {
          resolve()
          return
        }
        if (Date.now() - started > 2000) {
          reject(new Error(`Timed out waiting for ${label}`))
          return
        }
        setTimeout(check, 5)
      }
      check()
    })
  )

const dropConnection = () => {
  const connection = broker.current
  if (connection === undefined || connection.closed) {
    return
  }
  broker.suspended = true
  for (const channel of connection.channels) {
    if (!channel.closed) {
      channel.closed = true
      channel.emit("close")
    }
  }
  connection.closed = true
  connection.emit("close")
}

const layer = AMQPChannel.layer({
  retryConnectionSchedule: Schedule.spaced("10 millis"),
  retryConsumptionSchedule: Schedule.spaced("10 millis"),
  waitChannelTimeout: "2 seconds"
}).pipe(
  Layer.provideMerge(
    AMQPConnection.layer({
      hostname: "127.0.0.1",
      port: 5672,
      username: "guest",
      password: "guest"
    }, {
      retryConnectionSchedule: Schedule.spaced("10 millis"),
      waitConnectionTimeout: "2 seconds",
      connectionTimeout: "2 seconds"
    })
  )
)

describe("AMQP reconnect", () => {
  it.live("resumes the same queue after the connection drops and keeps a publish from that window", () => {
    broker.reset()
    broker.armHold()

    return Effect.gen(function*() {
      const received = yield* Queue.unbounded<string>()
      const publisher = yield* AMQPPublisher.make()
      const subscriber = yield* AMQPSubscriber.make(QUEUE)

      yield* subscriber.subscribe(Effect.gen(function*() {
        const message = yield* AMQPConsumeMessage.AMQPConsumeMessage
        yield* Queue.offer(received, message.content.toString())
        return AMQPSubscriberResponse.ack()
      })).pipe(Effect.forkChild)

      yield* waitFor("initial consume", () => broker.consumeQueues.length === 1)
      expect(broker.consumeQueues).toEqual([QUEUE])

      yield* publisher.publish({
        exchange: "",
        routingKey: QUEUE,
        content: Buffer.from("before")
      })
      expect(yield* Queue.take(received)).toBe("before")
      const originalConnection = broker.publishes[0]?.connectionId
      expect(originalConnection).toBe(1)

      dropConnection()
      yield* waitFor("reconnect attempt", () => broker.reconnectStarted)
      const consumesWhileDown = broker.consumeQueues.length
      const publishesWhileDown = broker.publishes.length

      const during = yield* publisher.publish({
        exchange: "",
        routingKey: QUEUE,
        content: Buffer.from("during")
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)))

      // The channel is gone, so this publish stays in flight instead of resolving as sent.
      expect(during.pollUnsafe()).toBeUndefined()
      expect(broker.publishes).toHaveLength(publishesWhileDown)
      expect(broker.consumeQueues).toHaveLength(consumesWhileDown)
      expect(Option.isNone(yield* Queue.poll(received))).toBe(true)

      broker.releaseHold()
      yield* Fiber.join(during)
      yield* waitFor("resumed consume", () => broker.consumeQueues.length > consumesWhileDown)

      expect(broker.consumeQueues.every((queue) => queue === QUEUE)).toBe(true)
      expect(yield* Queue.take(received)).toBe("during")
      const duringPublish = broker.publishes.filter((message) => message.body === "during")
      expect(duringPublish).toHaveLength(1)
      expect(duringPublish[0]).toMatchObject({
        exchange: "",
        routingKey: QUEUE
      })
      expect(duringPublish[0]?.connectionId).toBeGreaterThan(originalConnection ?? 0)

      yield* publisher.publish({
        exchange: "",
        routingKey: QUEUE,
        content: Buffer.from("after")
      })
      expect(yield* Queue.take(received)).toBe("after")
    }).pipe(Effect.provide(layer))
  })
})
