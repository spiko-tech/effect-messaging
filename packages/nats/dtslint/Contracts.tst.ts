import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import { describe, expect, it } from "tstyche"
import type {
  JetStreamClient,
  JetStreamConsumer,
  JetStreamMessage,
  JetStreamTypes,
  NATSConnection,
  NATSError,
  NATSMessage,
  NATSNodeConnection
} from "../src/index.ts"

declare const connection: NATSConnection.NATSConnection
declare const consumer: JetStreamConsumer.Consumer
declare const client: JetStreamClient.JetStreamClient
declare const node: typeof NATSNodeConnection

describe("native NATS contracts", () => {
  it("owns connection resources in its layer", () => {
    expect(node.layer()).type.toBe<Layer.Layer<NATSConnection.NATSConnection, NATSError.NATSConnectionError>>()
    expect(node.make()).type.toBe<
      Effect.Effect<NATSConnection.NATSConnection, NATSError.NATSConnectionError, Scope.Scope>
    >()
  })

  it("keeps request errors and optional closure reasons typed", () => {
    expect(connection.request("events")).type.toBe<
      Effect.Effect<NATSMessage.NATSMessage, NATSError.NATSConnectionError>
    >()
    expect(connection.requestMany("events")).type.toBe<
      Effect.Effect<
        Stream.Stream<NATSMessage.NATSMessage, NATSError.NATSConnectionError>,
        NATSError.NATSConnectionError
      >
    >()
    expect(connection.closed).type.toBe<Effect.Effect<Option.Option<NATSError.NATSConnectionError>>>()
  })

  it("requires a scope for long-lived consumer operations", () => {
    expect(consumer.fetch()).type.toBe<
      Effect.Effect<JetStreamConsumer.ConsumerMessages, NATSError.JetStreamConsumerError, Scope.Scope>
    >()
    expect(consumer.consume()).type.toBe<
      Effect.Effect<JetStreamConsumer.ConsumerMessages, NATSError.JetStreamConsumerError, Scope.Scope>
    >()
    expect(consumer.next()).type.toBe<
      Effect.Effect<Option.Option<JetStreamMessage.JetStreamMessage>, NATSError.JetStreamConsumerError>
    >()
  })

  it("publishes using owned acknowledgement types", () => {
    expect(client.publish("events", "hello")).type.toBe<
      Effect.Effect<JetStreamTypes.PubAck, NATSError.JetStreamClientError>
    >()
  })
})
