import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as AMQPChannel from "../src/AMQPChannel.js"
import * as AMQPConnection from "../src/AMQPConnection.js"

export const testConnection = AMQPConnection.layer({
  url: {
    hostname: "localhost",
    port: 5679,
    username: "guest",
    password: "guest"
  }
})

export const testChannel = AMQPChannel.layer().pipe(Layer.provideMerge(testConnection))

export const TEST_EXCHANGE = "TEST_EXCHANGE"
export const TEST_QUEUE = "TEST_QUEUE"
export const TEST_SUBJECT = "TEST_SUBJECT"

export const assertTestExchange = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  return yield* channel.assertExchange(TEST_EXCHANGE, "direct", { durable: true })
})

export const simulateConnectionClose = Effect.gen(function*() {
  const connection = yield* AMQPConnection.AMQPConnection
  yield* connection.close({ removeAllListeners: false })
})

export const simulateChannelClose = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  yield* channel.close({ removeAllListeners: false })
})

export const purgeTestQueue = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  return yield* channel.purgeQueue(TEST_QUEUE)
})

export const assertTestQueue = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  return yield* channel.assertQueue(TEST_QUEUE, { durable: true })
})

export const bindTestQueue = Effect.gen(function*() {
  const channel = yield* AMQPChannel.AMQPChannel
  return yield* channel.bindQueue(TEST_QUEUE, TEST_EXCHANGE, TEST_SUBJECT)
})
