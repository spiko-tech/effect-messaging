import * as NATSConnection from "../src/NATSConnection.js"

export const testConnection = NATSConnection.layerNode({
  servers: "localhost:4222"
})
