import { AckPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as JetStreamClient from "../src/JetStreamClient.js"
import * as JetStreamManager from "../src/JetStreamManager.js"
import * as NATSConnection from "../src/NATSConnection.js"

export const testConnection = NATSConnection.layerNode({
  servers: "localhost:4222"
})

export const testJetStreamClient = JetStreamClient.layer().pipe(Layer.provideMerge(testConnection))

export const testJetStreamManager = JetStreamManager.layer().pipe(Layer.provideMerge(testConnection))

export const testJetStream = Layer.provideMerge(testJetStreamClient, testJetStreamManager)

// Test constants
export const TEST_STREAM = "TEST_STREAM"
export const TEST_CONSUMER = "TEST_CONSUMER"
export const TEST_SUBJECT = "test.subject"

// Scoped helper to create and cleanup a test stream
export const makeTestStream = (
  name: string = TEST_STREAM,
  subjects: Array<string> = [TEST_SUBJECT]
) =>
  Effect.acquireRelease(
    JetStreamManager.JetStreamManager.pipe(
      Effect.flatMap((manager) =>
        manager.streams.add({
          name,
          subjects,
          storage: StorageType.Memory,
          retention: RetentionPolicy.Workqueue,
          max_msgs: 1000,
          max_bytes: 1024 * 1024,
          max_age: 60_000_000_000,
          max_msg_size: 1024,
          num_replicas: 1
        })
      )
    ),
    (streamInfo) =>
      JetStreamManager.JetStreamManager.pipe(
        Effect.flatMap((manager) => manager.streams.delete(streamInfo.config.name)),
        Effect.orDie
      )
  )

// Scoped helper to create and cleanup a test consumer
export const makeTestConsumer = (
  stream: string = TEST_STREAM,
  name: string = TEST_CONSUMER,
  options?: { ack_wait?: number }
) =>
  Effect.acquireRelease(
    JetStreamManager.JetStreamManager.pipe(
      Effect.flatMap((manager) =>
        manager.consumers.add(stream, {
          name,
          durable_name: name,
          ack_policy: AckPolicy.Explicit,
          max_deliver: 10,
          // Default to 500ms for tests, allows faster redelivery
          ack_wait: options?.ack_wait ?? 500_000_000
        })
      )
    ),
    (consumerInfo) =>
      JetStreamManager.JetStreamManager.pipe(
        Effect.flatMap((manager) => manager.consumers.delete(stream, consumerInfo.name)),
        Effect.orDie
      )
  )

// Scoped helper that creates both stream and consumer
export const makeTestStreamAndConsumer = (
  streamName: string = TEST_STREAM,
  consumerName: string = TEST_CONSUMER,
  subjects: Array<string> = [TEST_SUBJECT],
  consumerOptions?: { ack_wait?: number }
) =>
  Effect.gen(function*() {
    yield* makeTestStream(streamName, subjects)
    return yield* makeTestConsumer(streamName, consumerName, consumerOptions)
  })

// Helper to purge a stream
export const purgeTestStream = (streamName: string = TEST_STREAM) =>
  JetStreamManager.JetStreamManager.pipe(
    Effect.flatMap((manager) => manager.streams.purge(streamName))
  )
