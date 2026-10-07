// Vendored from Effect's private tooling (@effect/oxc). MIT licensed.
// Source: https://github.com/Effect-TS/effect/blob/ee6ffbfde3d14bb61d8588feaaf132f34098569b/packages/tools/oxc/src/oxlint/index.ts
// See ./LICENSE in this directory for the full license text.
import noBigIntLiterals from "./rules/no-bigint-literals.ts"
import noImportFromBarrelPackage from "./rules/no-import-from-barrel-package.ts"
import noJsExtensionImports from "./rules/no-js-extension-imports.ts"
import noOpaqueInstanceFields from "./rules/no-opaque-instance-fields.ts"

export default {
  meta: {
    name: "effect"
  },
  rules: {
    "no-bigint-literals": noBigIntLiterals,
    "no-import-from-barrel-package": noImportFromBarrelPackage,
    "no-js-extension-imports": noJsExtensionImports,
    "no-opaque-instance-fields": noOpaqueInstanceFields
  }
}
