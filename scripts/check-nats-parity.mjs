// Validate the case-level audit against the pinned inventory and native case labels.
// This checks evidence links; passing it does not prove behavioral equivalence.
import { parseSync } from "@babel/core"
import { readdir, readFile } from "node:fs/promises"

const workspace = new URL("../", import.meta.url)
const tests = new URL("packages/nats/test/", workspace)
const inventory = JSON.parse(await readFile(new URL("upstream-v3.4.0-inventory.json", tests), "utf8"))
const groups = Object.values(inventory).flatMap((entry) => entry.tests ?? [])
const upstream = new Map()
for (const group of groups) {
  for (const test of group.cases) {
    const key = `${group.file}\n${test.name}`
    const matches = upstream.get(key) ?? []
    matches.push(test)
    upstream.set(key, matches)
  }
}
const covered = new Set()
const outside = new Set()
const artifacts = (await readdir(tests)).filter((file) => /^upstream-.*-mapping\.json$/.test(file)).sort()
const sources = new Map()

for (const artifact of artifacts) {
  const mapping = JSON.parse(await readFile(new URL(artifact, tests), "utf8"))
  const seen = new Set()
  const cases = mapping.cases.map((test) =>
    test.upstream_case === undefined ? test : {
      upstreamFile: mapping.upstream_file,
      upstreamTestName: test.upstream_case,
      status: "covered",
      nativeTests: [{ file: mapping.native_file, testName: test.native_case, evidence: test.adaptation }]
    }
  )
  for (const test of cases) {
    const name = `${test.upstreamFile}\n${test.upstreamTestName}`
    const candidates = upstream.get(name)
    if (!candidates) throw new Error(`${artifact}: unknown upstream case ${name}`)
    const source = test.upstreamLine === undefined && candidates.length === 1 ?
      candidates[0] :
      candidates.find((candidate) => candidate.line === test.upstreamLine)
    if (!source) throw new Error(`${artifact}: duplicate upstream names need an exact upstreamLine: ${name}`)
    const key = `${test.upstreamFile}\n${source.line}`
    if (seen.has(key)) throw new Error(`${artifact}: duplicate case ${key}`)
    seen.add(key)
    if (test.status === "outside-baseline") {
      if (!test.reason) throw new Error(`${artifact}: excluded case needs a reason: ${key}`)
      outside.add(key)
      continue
    }
    if (test.status === "uncovered") continue
    if (test.status !== "covered") throw new Error(`${artifact}: unknown status ${test.status}: ${key}`)
    if (!test.nativeTests?.length) throw new Error(`${artifact}: covered case has no evidence: ${key}`)
    for (const target of test.nativeTests) {
      if (!target.file.startsWith("packages/nats/test/") || !target.file.endsWith(".test.ts")) {
        throw new Error(`${artifact}: evidence must refer to a native test file: ${target.file}`)
      }
      if (!sources.has(target.file)) {
        const source = parseSync(await readFile(new URL(target.file, workspace), "utf8"), {
          babelrc: false,
          configFile: false,
          parserOpts: { sourceType: "module", plugins: ["typescript"] }
        })
        const names = new Set()
        const pending = [source]
        while (pending.length > 0) {
          const node = pending.pop()
          if (node === null || typeof node !== "object") continue
          if (node.type === "StringLiteral") names.add(node.value)
          if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
            names.add(node.quasis[0].value.cooked)
          }
          pending.push(...Object.values(node))
        }
        sources.set(target.file, names)
      }
      if (!target.testName || !sources.get(target.file).has(target.testName)) {
        throw new Error(`${artifact}: native case label not found: ${target.file}: ${target.testName}`)
      }
      if (!target.evidence) throw new Error(`${artifact}: evidence needs an explanation: ${key}`)
    }
    covered.add(key)
  }
  if (mapping.total !== undefined && mapping.total !== cases.length) {
    throw new Error(`${artifact}: case total ${mapping.total} does not match ${cases.length} entries`)
  }
}

for (const key of outside) {
  if (covered.has(key)) throw new Error(`Case is both covered and excluded: ${key}`)
}
const total = groups.reduce((count, group) => count + group.declaredCases, 0)
for (const group of groups) {
  if (group.auditCases === undefined) continue
  const mapped = group.cases.filter((test) => covered.has(`${group.file}\n${test.line}`)).length
  const excluded = group.cases.filter((test) => outside.has(`${group.file}\n${test.line}`)).length
  if (
    group.auditCases.covered !== mapped || group.auditCases.outsideBaseline !== excluded ||
    group.auditCases.uncovered !== group.declaredCases - mapped - excluded
  ) {
    throw new Error(`Inventory audit totals are stale: ${group.file}`)
  }
}
const fullyMapped =
  groups.filter((group) =>
    group.cases.every((test) =>
      covered.has(`${group.file}\n${test.line}`) || outside.has(`${group.file}\n${test.line}`)
    )
  ).length
console.log(
  `${artifacts.length} audit artifacts checked: ${covered.size}/${total} upstream cases mapped, ` +
    `${outside.size} outside baseline, ${fullyMapped}/${groups.length} file groups fully mapped`
)
if (process.argv.includes("--require-complete") && covered.size + outside.size !== total) {
  throw new Error(`${total - covered.size - outside.size} upstream cases still require an audit`)
}
