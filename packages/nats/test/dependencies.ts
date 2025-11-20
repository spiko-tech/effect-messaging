import type * as JetStream from "@nats-io/jetstream"
import { AckPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as JetStreamClient from "../src/JetStreamClient.js"
import * as JetStreamManager from "../src/JetStreamManager.js"
import * as NATSConnection from "../src/NATSConnection.js"
import type * as NATSError from "../src/NATSError.js"

export const testConnection = NATSConnection.layerNode({
  servers: "localhost:4222"
})

export const testJetStreamClient = JetStreamClient.layer().pipe(Layer.provideMerge(testConnection))

export const testJetStreamManager = JetStreamManager.layer().pipe(Layer.provideMerge(testConnection))

// Test constants
export const TEST_STREAM = "TEST_STREAM"
export const TEST_CONSUMER = "TEST_CONSUMER"
export const TEST_SUBJECT = "test.subject"

// Helper to create a test stream
export const createTestStream = (
  subjects: Array<string> = [TEST_SUBJECT]
): Effect.Effect<
  JetStream.StreamInfo,
  NATSError.JetStreamManagerError | NATSError.JetStreamStreamAPIError,
  JetStreamManager.JetStreamManager
> =>
  Effect.gen(function*() {
    const manager = yield* JetStreamManager.JetStreamManager
    const lister = yield* manager.streams.list()
    const existingStreams = yield* Stream.runCollect(lister.stream).pipe(Effect.map((chunk) => Array.from(chunk)))

    // Delete stream if it exists
    if (existingStreams.some((s: JetStream.StreamInfo) => s.config.name === TEST_STREAM)) {
      yield* manager.streams.delete(TEST_STREAM)
    }

    return yield* manager.streams.add({
      name: TEST_STREAM,
      subjects,
      storage: StorageType.Memory,
      retention: RetentionPolicy.Workqueue,
      max_msgs: 1000,
      max_bytes: 1024 * 1024,
      max_age: 60_000_000_000, // 60 seconds in nanoseconds
      max_msg_size: 1024,
      num_replicas: 1
    })
  })

// Helper to create a test consumer
export const createTestConsumer = (
  stream = TEST_STREAM,
  name = TEST_CONSUMER
): Effect.Effect<
  JetStream.ConsumerInfo,
  NATSError.JetStreamConsumerAPIError | NATSError.JetStreamManagerError,
  JetStreamManager.JetStreamManager
> =>
  Effect.gen(function*() {
    const manager = yield* JetStreamManager.JetStreamManager
    const lister = yield* manager.consumers.list(stream)
    const existingConsumers = yield* Stream.runCollect(lister.stream).pipe(Effect.map((chunk) => Array.from(chunk)))

    // Delete consumer if it exists
    if (existingConsumers.some((c: JetStream.ConsumerInfo) => c.name === name)) {
      yield* manager.consumers.delete(stream, name)
    }

    return yield* manager.consumers.add(stream, {
      name,
      durable_name: name,
      ack_policy: AckPolicy.Explicit,
      max_deliver: 10,
      ack_wait: 30_000_000_000 // 30 seconds in nanoseconds
    })
  })

// Helper to delete test stream
export const deleteTestStream = (
  stream = TEST_STREAM
): Effect.Effect<
  boolean,
  NATSError.JetStreamStreamAPIError | NATSError.JetStreamManagerError,
  JetStreamManager.JetStreamManager
> =>
  Effect.gen(function*() {
    const manager = yield* JetStreamManager.JetStreamManager
    const lister = yield* manager.streams.list()
    const existingStreams = yield* Stream.runCollect(lister.stream).pipe(Effect.map((chunk) => Array.from(chunk)))

    if (existingStreams.some((s: JetStream.StreamInfo) => s.config.name === stream)) {
      return yield* manager.streams.delete(stream)
    }
    return true
  })

// Helper to delete test consumer
export const deleteTestConsumer = (
  stream = TEST_STREAM,
  name = TEST_CONSUMER
): Effect.Effect<
  boolean,
  NATSError.JetStreamConsumerAPIError | NATSError.JetStreamManagerError,
  JetStreamManager.JetStreamManager
> =>
  Effect.gen(function*() {
    const manager = yield* JetStreamManager.JetStreamManager
    const lister = yield* manager.consumers.list(stream)
    const existingConsumers = yield* Stream.runCollect(lister.stream).pipe(Effect.map((chunk) => Array.from(chunk)))

    if (existingConsumers.some((c: JetStream.ConsumerInfo) => c.name === name)) {
      return yield* manager.consumers.delete(stream, name)
    }
    return true
  })
