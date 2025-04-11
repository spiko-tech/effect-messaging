import * as Layer from "effect/Layer"
import * as AMQPChannel from "../src/AMQPChannel.js"
import * as AMQPConnection from "../src/AMQPConnection.js"

export const testConnection = AMQPConnection.layer({
  hostname: "localhost",
  port: 5679,
  username: "guest",
  password: "guest"
})

export const testChannel = AMQPChannel.layer.pipe(Layer.provide(testConnection))
