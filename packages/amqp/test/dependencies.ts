import * as Layer from "effect/Layer"
import * as AMQPChannel from "../src/AMQPChannel.ts"
import * as AMQPNodeConnection from "../src/AMQPNodeConnection.ts"

export const broker = {
  hostname: process.env["AMQP_TEST_HOST"] ?? "localhost",
  port: Number(process.env["AMQP_TEST_PORT"] ?? 5679),
  username: "guest",
  password: "guest"
}

export const testConnection = AMQPNodeConnection.layer(broker)
export const testChannel = AMQPChannel.layer().pipe(Layer.provideMerge(testConnection))
export const testConfirmChannel = AMQPChannel.layer({ confirm: true }).pipe(Layer.provideMerge(testConnection))
export const encode = (value: string) => new TextEncoder().encode(value)
export const decode = (value: Uint8Array) => new TextDecoder().decode(value)
