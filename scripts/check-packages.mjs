import { execFileSync } from "node:child_process"
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const requestedPackages = process.argv.length > 2 ? process.argv.slice(2) : ["amqp", "core", "nats"]
const packages = requestedPackages.includes("core") ? requestedPackages : ["core", ...requestedPackages]
const temporaryDirectory = await mkdtemp(join(tmpdir(), "effect-messaging-packages-"))
const esmSpecifiers = []
const cjsSpecifiers = []

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
      await readFile(new URL(`../packages/${name}/dist/package.json`, import.meta.url), "utf8")
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

    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === "./package.json" || typeof target === "string") {
        continue
      }
      for (const file of Object.values(target)) {
        await access(new URL(file, directory))
      }

      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
      esmSpecifiers.push(specifier)
      cjsSpecifiers.push(specifier)
    }
  }

  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", `await Promise.all(${JSON.stringify(esmSpecifiers)}.map((_) => import(_)))`],
    { cwd: temporaryDirectory, stdio: "inherit" }
  )
  execFileSync(
    process.execPath,
    ["--eval", `for (const specifier of ${JSON.stringify(cjsSpecifiers)}) require(specifier)`],
    { cwd: temporaryDirectory, stdio: "inherit" }
  )
  await writeFile(
    join(temporaryDirectory, "index.ts"),
    esmSpecifiers.map((specifier) => `import "${specifier}"`).join("\n")
  )
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--lib",
      "ESNext,DOM",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node",
      join(temporaryDirectory, "index.ts")
    ],
    { stdio: "inherit" }
  )
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
