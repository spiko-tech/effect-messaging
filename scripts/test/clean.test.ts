import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"

const cleanScript = fileURLToPath(new URL("../clean.mjs", import.meta.url))

const withFixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "effect-messaging-clean-"))
  try {
    await run(directory)
  } finally {
    await Fs.rm(directory, { recursive: true, force: true })
  }
}

const writeFiles = (directory: string, files: Array<string>) =>
  Promise.all(files.map(async (file) => {
    const path = Path.join(directory, file)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, "preserved\n")
  }))

describe("clean", () => {
  it("removes current and legacy compiler caches without removing sources or dependency caches", () =>
    withFixture(async (directory) => {
      const caches = [
        "tsconfig.tsbuildinfo",
        "tsconfig.packages.tsbuildinfo",
        "tsconfig.tests.tsbuildinfo",
        ".tsbuildinfo/build.tsbuildinfo",
        ...["amqp", "core", "nats"].flatMap((name) => [
          `packages/${name}/tsconfig.tsbuildinfo`,
          `packages/${name}/.tsbuildinfo/src.tsbuildinfo`
        ])
      ]
      const preserved = [
        "tsconfig.json",
        "packages/core/tsconfig.json",
        "packages/core/src/index.ts",
        "node_modules/dependency/tsconfig.tsbuildinfo",
        "packages/core/node_modules/dependency/tsconfig.tsbuildinfo",
        "docs/README.md"
      ]
      await writeFiles(directory, [...caches, ...preserved])

      execFileSync(process.execPath, [cleanScript], { cwd: directory })

      for (const cache of caches) {
        expect(existsSync(Path.join(directory, cache)), cache).toBe(false)
      }
      for (const file of preserved) {
        expect(await Fs.readFile(Path.join(directory, file), "utf8")).toBe("preserved\n")
      }
    }))

  it("removes generated outputs and tolerates repeated cleanup", () =>
    withFixture(async (directory) => {
      const outputs = [
        "dist/index.js",
        "build/index.js",
        "coverage/coverage.json",
        "packages/core/dist/index.js",
        "packages/core/build/index.js",
        "packages/core/coverage/coverage.json",
        "packages/core/docs/modules/index.md",
        "docs/core/index.md"
      ]
      await writeFiles(directory, outputs)

      execFileSync(process.execPath, [cleanScript], { cwd: directory })
      execFileSync(process.execPath, [cleanScript], { cwd: directory })

      for (const output of outputs) {
        expect(existsSync(Path.join(directory, output)), output).toBe(false)
      }
    }))
})
