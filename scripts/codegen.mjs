#!/usr/bin/env node
// Barrel (`@barrel`) code generator.
//
// Adapted into a dependency-light Node script from Effect's private
// `@effect/utils` codegen tool (`Codegen.ts`). The original is MIT licensed;
// see ./oxlint/LICENSE for the full text (Effectful Technologies Inc).
// Source commit: ee6ffbfde3d14bb61d8588feaaf132f34098569b
//
// Behavior preserved from upstream:
// - Finds files annotated with `// @barrel` (optionally `// @barrel(pattern)`).
// - Discovers matching sibling modules (default pattern `*.ts`).
// - Requires every matched module to expose exactly one top-level `@since`
//   tag in its leading JSDoc block, copying it into a minimal JSDoc block.
// - Copies `@stability` unless the module lives under `internal/` or its
//   header is `@internal`.
// - Rewrites everything after the annotation with the generated exports.
//
// Usage:
//   node scripts/codegen.mjs [cwd] [pattern]
//
// Defaults to the repository root and every package barrel
// (`packages/*/src/**\/index.ts`).
import { glob } from "glob"
import { readFile, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const parseAnnotation = (line) => {
  const match = line.match(/^\/\/\s*@barrel(?:\((.+?)\))?/)
  if (match === null) {
    return undefined
  }
  return match[1] ?? "*.ts"
}

const findAnnotation = (content) => {
  const lines = content.split("\n")

  // Find the line containing the annotation
  let annotationLine = -1
  let pattern
  for (let i = 0; i < lines.length; i++) {
    pattern = parseAnnotation(lines[i])
    if (pattern !== undefined) {
      annotationLine = i
      break
    }
  }

  if (annotationLine === -1 || pattern === undefined) {
    return undefined
  }

  // Walk forwards to find the end of the comment block
  let commentEnd = annotationLine
  while (commentEnd < lines.length - 1 && lines[commentEnd + 1].trimStart().startsWith("//")) {
    commentEnd++
  }

  return { pattern, offset: commentEnd + 1 }
}

const isInternalModule = (file, block) =>
  file.split(/[/\\]/).includes("internal") || /^\s*\*\s*@internal\s*$/m.test(block)

const extractModuleMetadata = (file, content) => {
  const block = content.match(/^\s*(\/\*\*[\s\S]*?\*\/)/)?.[1]
  if (block === undefined) {
    throw new Error(`${file}: missing top-level module JSDoc`)
  }
  const matches = Array.from(block.matchAll(/^\s*\*\s*@since(?:\s+(.*))?$/gm))
  if (matches.length !== 1) {
    throw new Error(
      `${file}: ${matches.length === 0 ? "missing" : "multiple"} top-level module @since tag`
    )
  }
  const since = matches[0]?.[1]?.trim() ?? ""
  if (since.length === 0) {
    throw new Error(`${file}: empty top-level module @since tag`)
  }
  return {
    since,
    stability: isInternalModule(file, block)
      ? undefined
      : /^\s*\*\s*@stability\s+(unstable|experimental)\s*$/m.exec(block)?.[1]
  }
}

const renderExportJSDoc = ({ since, stability }) =>
  `/**\n${stability ? ` * @stability ${stability}\n` : ""} * @since ${since}\n */`

// Convert native path separators to POSIX (forward slashes) for import/export statements
const toPosix = (file) => (sep === "/" ? file : file.split(sep).join("/"))

const fileToModuleName = (posix) => posix.slice(0, -extname(posix).length).replace(/\//g, "_")

const processModule = async (directory, file) => {
  const fullPath = join(directory, file)
  const posixPath = toPosix(file)
  const content = await readFile(fullPath, "utf8")
  const metadata = extractModuleMetadata(fullPath, content)
  const moduleName = fileToModuleName(posixPath)
  return `${renderExportJSDoc(metadata)}\nexport * as ${moduleName} from "./${posixPath}"`
}

const discoverFiles = async (pattern, cwd) => {
  const indexFiles = await glob(pattern, { cwd, dot: false, follow: false, nodir: true })
  const results = []
  for (const file of indexFiles) {
    const fullPath = isAbsolute(file) ? file : join(cwd, file)
    const content = await readFile(fullPath, "utf8")
    const parsed = findAnnotation(content)
    if (parsed !== undefined) {
      results.push({ path: fullPath, ...parsed })
    }
  }
  // Generated exports are wildcard re-exports, so ordering is presentation only.
  return results.sort((self, that) => self.path.localeCompare(that.path))
}

const processFile = async (file) => {
  const { offset, pattern } = file
  const directory = dirname(file.path)
  const self = basename(file.path)

  // Find all matching files relative to the current directory excluding the barrel file itself
  const matchedFiles = (await glob(pattern, {
    cwd: directory,
    dot: false,
    follow: false,
    nodir: true,
    ignore: [self]
  })).sort((a, b) => a.localeCompare(b))

  const moduleContents = []
  for (const matched of matchedFiles) {
    moduleContents.push(await processModule(directory, matched))
  }

  const content = await readFile(file.path, "utf8")
  const header = content.split("\n").slice(0, offset).join("\n")
  const generated = moduleContents.join("\n\n")

  await writeFile(file.path, `${header}\n\n${generated}\n`)
}

const cwd = resolve(process.argv[2] ?? repositoryRoot)
const pattern = process.argv[3] ?? "packages/*/src/**/index.ts"

const files = await discoverFiles(pattern, cwd)
await Promise.all(files.map((file) => processFile(file)))
console.log(`Generated ${files.length} barrel file(s)`)
