import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "amqp-broker-qualification",
    include: [fileURLToPath(new URL("../../AMQPBrokerQualification.test.ts", import.meta.url))],
    sequence: { concurrent: false },
    fileParallelism: false,
    hookTimeout: 240000,
    testTimeout: 360000
  }
})
