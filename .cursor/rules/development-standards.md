# Development Standards

## Type Safety

- **Never use `any` type** - Always use proper TypeScript typing
- **Avoid type casting with `as`** - Only use type casting when absolutely necessary and when types are properly validated
- Use `unknown` for uncertain types and narrow them with type guards
- Prefer `Schema.Defect` for error causes instead of casting to `any`
- Use proper generic constraints and type inference
- Follow Effect's type system patterns for structured error handling

## Dependencies

When updating dependencies:
- Update root package.json and all relevant package-specific package.json files
- Run `pnpm changeset` to create version bump
- Use patch version for dependency updates
- Include specific version ranges in changeset summary

## Effect Libraries

This project uses Effect ecosystem libraries:
- effect (core library)
- @effect/platform (platform abstractions)
- @effect/vitest (testing utilities)
- @effect/build-utils (build tooling)

Keep these in sync across all packages and maintain compatibility.