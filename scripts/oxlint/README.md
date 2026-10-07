# scripts/oxlint

Vendored subset of Effect's private oxlint JS plugin (`@effect/oxc`).

These rules are required so that `oxlint` can enforce Effect's repository
conventions locally:

- `effect/no-js-extension-imports` — relative imports/exports must use the
  TypeScript extension (`.ts`, `.tsx`, `.mts`, `.cts`) instead of `.js`.
- `effect/no-import-from-barrel-package` — imports must target a concrete
  module (for example `effect/Effect`) rather than a package barrel or an
  `index` file.
- `effect/no-bigint-literals`
- `effect/no-opaque-instance-fields`

## Attribution

Rule implementations vendored verbatim (aside from attribution headers) from the Effect
repository, package `packages/tools/oxc`:

- Repository: https://github.com/Effect-TS/effect
- Commit: `ee6ffbfde3d14bb61d8588feaaf132f34098569b`
- License: MIT — see [`LICENSE`](./LICENSE)

The upstream sources are published as `@effect/oxc`, which is private and
therefore not consumable as a dependency. They are kept here, minimally, so the
repository can run the same lint rules without that private package.

## Wiring

`oxlint` loads the plugin through the root `.oxlintrc.json`:

```json
"jsPlugins": ["./scripts/oxlint/index.ts"]
```

The rules are declared under the `effect/*` namespace. The plugin is authored
in TypeScript and relies on Node.js native type stripping (see the repository's
`engines.node` requirement, `>=24.11.0`).

It requires `@oxlint/plugins` (the plugin type/authoring helpers) to be
available to Node's resolver at the repository root.
