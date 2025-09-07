import { Layer } from "effect"
import * as NATSConnection from "../src/NATSConnection.js"
import * as NATSJetStreamClient from "../src/NATSJetStreamClient.js"
import * as NATSJetStreamManager from "../src/NATSJetStreamManager.js"

export const testConnection = NATSConnection.layerNode({
  servers: "localhost:4222"
})

export const testJetStreamClient = NATSJetStreamClient.layer().pipe(Layer.provideMerge(testConnection))

export const testJetStreamManager = NATSJetStreamManager.layer().pipe(Layer.provideMerge(testConnection))
