import * as path from "node:path"
import type { ViteUserConfig } from "vitest/config"

const alias = (pkg: string, dir = pkg) => {
  const name = `@effect-messaging/${pkg}`
  const target = process.env.TEST_DIST !== undefined ? "dist" : "src"
  return ({
    [`${name}/test`]: path.join(import.meta.dirname, "packages", dir, "test"),
    [`${name}`]: path.join(import.meta.dirname, "packages", dir, target)
  })
}

const config: ViteUserConfig = {
  oxc: {
    target: "es2020"
  },
  test: {
    setupFiles: [path.join(import.meta.dirname, "vitest.setup.ts")],
    sequence: {
      concurrent: true
    },
    hookTimeout: 20000,
    include: ["test/**/*.test.ts"],
    alias: {
      ...alias("core"),
      ...alias("amqp")
    }
  }
}

export default config
