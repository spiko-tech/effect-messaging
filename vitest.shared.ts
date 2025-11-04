import * as path from "node:path"
import type { ViteUserConfig } from "vitest/config"

const alias = (pkg: string, dir = pkg) => {
  const name = `@effect-messaging/${pkg}`
  const target = process.env.TEST_DIST !== undefined ? path.join("dist", "dist", "esm") : "src"
  return ({
    [`${name}/test`]: path.join(__dirname, "packages", dir, "test"),
    [`${name}`]: path.join(__dirname, "packages", dir, target)
  })
}

const config: ViteUserConfig = {
  esbuild: {
    target: "es2020"
  },
  test: {
    setupFiles: [path.join(__dirname, "vitest.setup.ts")],
    fakeTimers: {
      toFake: undefined
    },
    sequence: {
      concurrent: true
    },
    hookTimeout: 20000,
    include: ["test/**/*.test.ts"],
    alias: {
      ...alias("amqp")
    }
  }
}

export default config
