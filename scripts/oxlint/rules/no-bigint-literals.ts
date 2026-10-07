// Vendored from Effect's private tooling (@effect/oxc). MIT licensed.
// Source: https://github.com/Effect-TS/effect/blob/ee6ffbfde3d14bb61d8588feaaf132f34098569b/packages/tools/oxc/src/oxlint/rules/no-bigint-literals.ts
// See ../LICENSE in this directory's parent for the full license text.
import type { CreateRule, Visitor } from "@oxlint/plugins"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow bigint literals" },
    fixable: "code"
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "bigint") {
          const fixedSource = `BigInt("${node.value}")`
          context.report({
            node,
            message: "BigInt literals are not allowed",
            fix: (fixer) => fixer.replaceText(node, fixedSource)
          })
        }
      }
    } as Visitor
  }
}

export default rule
