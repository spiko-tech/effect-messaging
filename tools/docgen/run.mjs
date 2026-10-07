import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve("@effect/docgen/package.json")
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
const executable = resolve(dirname(packageJsonPath), packageJson.bin.docgen)
const packagesDirectory = fileURLToPath(new URL("../../packages/", import.meta.url))
const toolBin = fileURLToPath(new URL("./node_modules/.bin/", import.meta.url))
// Example checks must use Docgen's supported classic compiler, not the native build compiler.
const env = { ...process.env, PATH: `${toolBin}${delimiter}${process.env.PATH ?? ""}` }

for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
  const directory = join(packagesDirectory, entry.name)
  if (entry.isDirectory() && existsSync(join(directory, "docgen.json"))) {
    execFileSync(process.execPath, [executable], { cwd: directory, env, stdio: "inherit" })
  }
}
