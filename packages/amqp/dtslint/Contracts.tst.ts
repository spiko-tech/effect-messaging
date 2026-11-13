import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import { describe, expect, it } from "tstyche"
import * as AMQPAuthentication from "../src/AMQPAuthentication.ts"
import type * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPConnection from "../src/AMQPConnection.ts"
import type * as AMQPConsumeMessage from "../src/AMQPConsumeMessage.ts"
import type * as AMQPError from "../src/AMQPError.ts"
import type * as AMQPTopology from "../src/AMQPTopology.ts"
import * as AMQPTypes from "../src/AMQPTypes.ts"

declare const channel: AMQPChannel.AMQPChannel
declare const factory: AMQPConnection.SocketFactory
declare const message: AMQPConsumeMessage.AMQPConsumeMessage
declare const properties: AMQPTypes.MessageProperties

describe("native AMQP capability contracts", () => {
  it("keeps socket and logical channel lifetimes scoped", () => {
    expect(AMQPConnection.make(factory)).type.toBe<
      Effect.Effect<AMQPConnection.AMQPConnection, AMQPError.AMQPError, Scope.Scope>
    >()
    expect(channel.connection.createChannel({ prefetch: 0 })).type.toBe<
      Effect.Effect<AMQPChannel.AMQPChannel, AMQPError.AMQPError, Scope.Scope>
    >()
    expect(channel.assertQueue("", { exclusive: true })).type.toBe<
      Effect.Effect<AMQPTopology.QueueReference, AMQPError.AMQPError>
    >()
  })

  it("supports real noAck and independent local buffering without weakening settlement errors", () => {
    expect(channel.get("queue", { noAck: true })).type.toBe<
      Effect.Effect<Option.Option<AMQPConsumeMessage.AMQPConsumeMessage>, AMQPError.AMQPError>
    >()
    expect(channel.consume("amq.rabbitmq.reply-to", { noAck: true, maxBufferedMessages: 16, prefetch: 0 })).type.toBe<
      Effect.Effect<Stream.Stream<AMQPConsumeMessage.AMQPConsumeMessage, AMQPError.AMQPError>, AMQPError.AMQPError>
    >()
    expect(channel.ack(message)).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
  })

  it("offers typed transaction commands and mechanism selection", () => {
    expect(channel.txSelect()).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
    expect(channel.txCommit()).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
    expect(channel.txRollback()).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
    expect(AMQPConnection.make(factory, { authentication: AMQPAuthentication.AMQPLAIN })).type.toBe<
      Effect.Effect<AMQPConnection.AMQPConnection, AMQPError.AMQPError, Scope.Scope>
    >()
  })

  it("accepts explicit scalar widths and legacy publish flags without broadening decoded properties", () => {
    expect(AMQPTypes.fieldInteger("uint32", 0xffffffff)).type.toBe<AMQPTypes.FieldInteger>()
    expect(AMQPTypes.fieldTimestamp(0xffffffffffffffffn)).type.toBe<AMQPTypes.FieldTimestamp>()
    expect(properties.deliveryMode).type.toBe<number | undefined>()
    expect(channel.sendToQueue("queue", new Uint8Array(0), {
      deliveryMode: true,
      headers: { integer: AMQPTypes.fieldInteger("int16", 1) }
    })).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
    expect(channel.flow(true)).type.toBe<Effect.Effect<boolean, AMQPError.AMQPError>>()
    expect(channel.recover(false)).type.toBe<Effect.Effect<void, AMQPError.AMQPError>>()
  })
})
