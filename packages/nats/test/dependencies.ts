import { Layer } from "effect"
import * as JetStreamClient from "../src/JetStreamClient.js"
import * as JetStreamManager from "../src/JetStreamManager.js"
import * as NATSConnection from "../src/NATSConnection.js"

export const testConnection = NATSConnection.layerNode({
  servers: "localhost:4222"
})

export const testJetStreamClient = JetStreamClient.layer().pipe(Layer.provideMerge(testConnection))

export const testJetStreamManager = JetStreamManager.layer().pipe(Layer.provideMerge(testConnection))
