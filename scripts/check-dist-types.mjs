// Type-checks the built `dist` declarations the way a consumer with
// `skipLibCheck: false` does. Run after `pnpm build` (which emits stripped
// declarations via `tsconfig.release.json`) to catch public declarations
// that reference `@internal` symbols or otherwise leak into the published types.
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"

const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..")
const packageNames = ["amqp", "core", "nats"]

/** Collects the specifiers of every public module emitted to `dist`. */
const collectPublicModules = (packageName, directory, prefix = "") => {
  const modules = []
  for (const entry of Fs.readdirSync(directory, { withFileTypes: true })) {
    // `internal` is intentionally not part of the public API.
    if (entry.name === "internal") {
      continue
    }

    if (entry.isDirectory()) {
      modules.push(...collectPublicModules(packageName, Path.join(directory, entry.name), `${prefix}${entry.name}/`))
      continue
    }

    if (!entry.name.endsWith(".d.ts")) {
      continue
    }

    const module = `${prefix}${entry.name.slice(0, -5)}`
    // The root `index` is reached through `.` and every other `index` through
    // the blocked `./*/index` subpath.
    if (module === "index" || module.endsWith("/index")) {
      continue
    }

    modules.push(`${packageName}/${module}`)
  }
  return modules
}

const entrypoints = []
const paths = {}

for (const name of packageNames) {
  const packageDirectory = Path.join(root, "packages", name)
  const dist = Path.join(packageDirectory, "dist")
  if (!Fs.existsSync(Path.join(dist, "index.d.ts"))) {
    console.error(`packages/${name}/dist is missing; run \`pnpm build\` first`)
    process.exit(1)
  }

  const manifest = JSON.parse(Fs.readFileSync(Path.join(packageDirectory, "package.json"), "utf8"))
  entrypoints.push(manifest.name)
  entrypoints.push(...collectPublicModules(manifest.name, dist))

  paths[manifest.name] = [Path.join(dist, "index.d.ts")]
  paths[`${manifest.name}/*`] = [Path.join(dist, "*")]
}

const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "effect-messaging-dist-types-"))
try {
  Fs.writeFileSync(
    Path.join(directory, "index.ts"),
    entrypoints.map((entry, i) => `import * as _${i} from "${entry}"\nexport { _${i} }\n`).join("")
  )
  Fs.writeFileSync(
    Path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        skipLibCheck: false,
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: ["node"],
        typeRoots: [Path.join(root, "node_modules", "@types")],
        paths
      },
      files: ["index.ts"]
    })
  )
  execFileSync("pnpm", ["exec", "tsc", "-p", Path.join(directory, "tsconfig.json")], { cwd: root, stdio: "inherit" })
} catch (error) {
  process.exitCode = typeof error.status === "number" ? error.status : 1
} finally {
  Fs.rmSync(directory, { force: true, recursive: true })
}
