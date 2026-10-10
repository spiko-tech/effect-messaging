// Packs every package the way it is published and validates the *real* packed
// artifacts end-to-end:
// Run after `pnpm build`, which emits stripped release declarations to `dist`.
//
//   1. `pnpm pack` each package (which applies `publishConfig.exports`).
//   2. Install the tarballs into a throwaway project.
//   3. Import every public wildcard module (`./*` -> `./dist/*.js`) as ESM.
//   4. Assert that the blocked `./internal/*`, `./index` and `./*/index` subpaths
//      are not importable.
//   5. Type-check every public module's declarations with `skipLibCheck: false`.
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const allPackages = ["amqp", "core", "nats"]
const requestedPackages = process.argv.length > 2 ? process.argv.slice(2) : allPackages
// Adapter entry points use `core` (an optional peer for AMQP), so include it in
// the all-entry-points fixture. The native-only fixture below omits it.
const packages = requestedPackages.includes("core") ? requestedPackages : ["core", ...requestedPackages]
const temporaryDirectory = await mkdtemp(join(tmpdir(), "effect-messaging-packages-"))
const specifiers = []
const blockedSpecifiers = []

/** Collects the specifiers of every module published under the `./*` wildcard. */
const collectPublicModules = async (packageName, directory, prefix = "") => {
  const modules = []
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    // `internal` is intentionally not part of the public API.
    if (entry.name === "internal") {
      continue
    }

    if (entry.isDirectory()) {
      modules.push(
        ...await collectPublicModules(packageName, new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
      )
      continue
    }

    if (!entry.name.endsWith(".js") || entry.name.endsWith(".js.map")) {
      continue
    }

    const module = `${prefix}${entry.name.slice(0, -3)}`
    // The root `index` is reached through `.` and every other `index` through
    // the blocked `./*/index` subpath.
    if (module === "index" || module.endsWith("/index")) {
      continue
    }

    modules.push(`${packageName}/${module}`)
  }

  return modules
}

try {
  const rootManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const dependencies = { "@types/node": rootManifest.devDependencies["@types/node"] }

  for (const name of packages) {
    execFileSync("pnpm", ["--filter", `@effect-messaging/${name}`, "pack", "--pack-destination", temporaryDirectory], {
      stdio: "ignore"
    })
    const archive = (await readdir(temporaryDirectory)).find((file) => file.startsWith(`effect-messaging-${name}-`))
    if (archive === undefined) {
      throw new Error(`Package archive not found for @effect-messaging/${name}`)
    }
    dependencies[`@effect-messaging/${name}`] = `file:${join(temporaryDirectory, archive)}`

    const manifest = JSON.parse(
      await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8")
    )
    for (const [dependency, version] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!dependency.startsWith("@effect-messaging/")) {
        dependencies[dependency] = version
      }
    }
  }

  await writeFile(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }, null, 2)
  )
  execFileSync("pnpm", ["install", "--dir", temporaryDirectory, "--ignore-scripts", "--no-frozen-lockfile"], {
    stdio: "ignore"
  })

  for (const name of requestedPackages) {
    const directory = new URL(`./node_modules/@effect-messaging/${name}/`, `file://${temporaryDirectory}/`)
    const manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8"))

    // The package root (`"."` -> `./dist/index.js`).
    specifiers.push(manifest.name)
    // Every module reachable through the `./*` wildcard (`./dist/*.js`).
    specifiers.push(...await collectPublicModules(manifest.name, new URL("dist/", directory)))

    // `internal` modules must not be reachable.
    const internalDirectory = new URL("dist/internal/", directory)
    const internalEntries = await readdir(internalDirectory).catch(() => [])
    const internalEntry = internalEntries.find((entry) => entry.endsWith(".js"))
    if (internalEntry !== undefined) {
      blockedSpecifiers.push(`${manifest.name}/internal/${internalEntry.slice(0, -3)}`)
    }
  }

  // 3. Import the real packed ESM entry points from outside the workspace.
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", `await Promise.all(${JSON.stringify(specifiers)}.map((_) => import(_)))`],
    { cwd: temporaryDirectory, stdio: "inherit" }
  )

  // 4. Assert the blocked subpaths stay blocked.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `for (const specifier of ${JSON.stringify(blockedSpecifiers)}) {
        try {
          await import(specifier)
          throw new Error("Expected " + specifier + " to be blocked by package exports")
        } catch (error) {
          if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error
        }
      }`
    ],
    { cwd: temporaryDirectory, stdio: "inherit" }
  )

  // 5. Type-check the published declarations of every public module.
  await writeFile(
    join(temporaryDirectory, "index.ts"),
    specifiers.map((specifier, i) => `import * as _${i} from "${specifier}"\nexport { _${i} }\n`).join("")
  )
  await writeFile(
    join(temporaryDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        skipLibCheck: false,
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: ["node"]
      },
      files: ["index.ts"]
    })
  )
  execFileSync("pnpm", ["exec", "tsc", "-p", join(temporaryDirectory, "tsconfig.json")], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit"
  })

  // The native AMQP entry point must work without optional core or Node adapters.
  if (requestedPackages.includes("amqp")) {
    const protocolDirectory = await mkdtemp(join(tmpdir(), "effect-messaging-amqp-protocol-"))
    try {
      await writeFile(
        join(protocolDirectory, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: {
            "@effect-messaging/amqp": dependencies["@effect-messaging/amqp"],
            effect: rootManifest.devDependencies.effect
          }
        })
      )
      execFileSync("pnpm", [
        "install",
        "--dir",
        protocolDirectory,
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--config.auto-install-peers=false"
      ], { stdio: "ignore" })
      execFileSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `
        for (const optional of ["@effect-messaging/core", "@effect/platform-node", "amqplib"]) {
          let present = false
          try { import.meta.resolve(optional); present = true } catch {}
          if (present) throw new Error("Unexpected optional dependency: " + optional)
        }
        const client = await import("@effect-messaging/amqp")
        if (!client.AMQPConnection || !client.AMQPChannel) throw new Error("Missing native exports")
      `
      ], { cwd: protocolDirectory, stdio: "inherit" })
      await writeFile(
        join(protocolDirectory, "index.ts"),
        "import { AMQPConnection, AMQPChannel, AMQPTypes } from \"@effect-messaging/amqp\"\n" +
          "export { AMQPConnection, AMQPChannel, AMQPTypes }\n"
      )
      await writeFile(
        join(protocolDirectory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            skipLibCheck: false,
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            types: []
          },
          files: ["index.ts"]
        })
      )
      execFileSync("pnpm", ["exec", "tsc", "-p", join(protocolDirectory, "tsconfig.json")], {
        cwd: new URL("..", import.meta.url),
        stdio: "inherit"
      })
    } finally {
      await rm(protocolDirectory, { force: true, recursive: true })
    }
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
