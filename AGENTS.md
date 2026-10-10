# Agent Guidelines for effect-messaging

## Learning more about Effect

This repository uses the Effect TypeScript library.
Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely and follow its links when needed.
For concepts not covered by that guide, search the source in `node_modules/effect/src`.

## Commands

- Build: `pnpm build`
- Test: `pnpm test` (single test: `pnpm test path/to/test.test.ts`)
- Lint: `pnpm lint` (fix: `pnpm lint-fix`)
- Type check: `pnpm check`
- Coverage: `pnpm coverage`

## Code Style

- Use Effect ecosystem libraries (effect, @effect/platform, @effect/vitest)
- Use Effect Schema codecs for external data; keep binary framing, shared constraints and allocation guards inside them
- Use typed Effect failures, not exceptions; reserve `Effect.try` for throwing external APIs
- Import style: `import type * as X from "module"` for types, regular imports for values
- No semicolons, no trailing commas
- 2-space indentation, 120 char line width
- Double quotes for strings
- Use `@since` JSDoc tags for new APIs
- Prefix unused variables with underscore
- Use generic array types: `Array<T>` not `T[]`

## Testing

- Run `pnpm build` and `pnpm lint` before testing
- Use @effect/vitest for testing utilities
- Test files in `test/` directories with `.test.ts` extension

## Changesets

- Always run `pnpm changeset` after changes
- Use patch for dependency updates/bug fixes
- Include specific version numbers in summaries
